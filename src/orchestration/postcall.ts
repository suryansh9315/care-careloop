import type { QuestionnaireResponse } from '@medplum/fhirtypes';
import { getModule } from '../conditions/registry.js';
import { checkEligibility } from '../integrations/stedi.js';
import { logger } from '../logger.js';
import type { CallOutcome, DraftPlan, PatientContext } from '../types.js';
import { loadPatientContext } from './context.js';
import { runExpertPanel } from './panel.js';
import { buildPatientRecap, writeDraftPlan, type WrittenPlan } from './plan.js';
import { researchPlan } from './research.js';
import { checkRegimenSafety, evaluateRisk, shouldEscalate } from './safety.js';
import { completeness, scoreInstrument, stepForBand } from './scoring.js';

/**
 * Everything that happens after the patient hangs up.
 *
 * Ordering is intentional:
 *   1. deterministic scoring, protocol selection and safety — these must
 *      succeed, and they are what actually shape the plan;
 *   2. optional enrichment (research, panel, coverage) in parallel — any of
 *      these can fail and the draft still gets written;
 *   3. FHIR write.
 *
 * The patient never waits on step 2.
 */

export interface PipelineResult {
  draft: DraftPlan;
  written: WrittenPlan;
  context: PatientContext;
  /** Enrichment steps that did not complete. Surfaced in the dashboard. */
  incomplete: string[];
}

export async function runPostCallPipeline(input: {
  outcome: CallOutcome;
  questionnaireResponse?: QuestionnaireResponse;
  context?: PatientContext;
}): Promise<PipelineResult> {
  const { outcome } = input;
  const module = getModule(outcome.moduleId);
  const incomplete: string[] = [];

  const context =
    input.context ??
    (await loadPatientContext({ patientId: outcome.patientId, moduleId: outcome.moduleId }));

  // --- 1. Deterministic core --------------------------------------------
  const score = scoreInstrument(module, outcome.answers);
  const step = stepForBand(module, score.band);
  const coverageOfCompletion = completeness(module, outcome.answers);
  if (!coverageOfCompletion.complete) {
    incomplete.push(
      `Instrument incomplete: ${coverageOfCompletion.answered} of ${coverageOfCompletion.total} items answered.`,
    );
  }

  const safety = checkRegimenSafety(step.medications, context);
  const risks = evaluateRisk(module, outcome.riskAnswers, score);
  const escalated = shouldEscalate({ urgentStep: step.urgent, safety, risks });

  logger.info(
    { callId: outcome.callId, total: score.total, band: score.band, step: step.id, escalated },
    'postcall.deterministic.complete',
  );

  // --- 2. Optional enrichment, in parallel -------------------------------
  const primaryMedication = step.medications.find((m) => m.role === 'primary' || m.role === 'controller') ?? step.medications[0];

  const [researchSettled, coverageSettled] = await Promise.allSettled([
    researchPlan({ module, context, score, step, concerns: outcome.concerns }),
    checkEligibility(context.coverage, primaryMedication),
  ]);

  const research = researchSettled.status === 'fulfilled' ? researchSettled.value : [];
  if (researchSettled.status === 'rejected') {
    incomplete.push('Evidence synthesis did not run.');
    logger.warn({ err: String(researchSettled.reason) }, 'postcall.research.failed');
  } else if (research.some((r) => !r.grounded)) {
    incomplete.push('Some evidence rationales fell back to deterministic text.');
  }

  const coverage = coverageSettled.status === 'fulfilled' ? coverageSettled.value : undefined;
  if (coverageSettled.status === 'rejected') {
    incomplete.push('Eligibility check did not run.');
  } else if (coverage?.mock) {
    incomplete.push('Coverage is a deterministic test result, not a live payer response.');
  }

  // The panel reviews the research, so it runs after it.
  let panel;
  try {
    panel = await runExpertPanel({
      module,
      score,
      step,
      safety,
      risks,
      research,
      escalated,
      currentMedications: context.currentMedications.map((m) => m.display),
      allergies: context.allergies,
    });
  } catch (error) {
    logger.warn({ err: String(error) }, 'postcall.panel.failed');
    incomplete.push('Expert panel did not run.');
    panel = { reviews: [], consensus: 'approve-with-notes' as const };
  }
  if (panel.reviews.length > 0 && panel.reviews.every((r) => !r.live)) {
    incomplete.push('Expert panel produced no live reviews.');
  }

  // --- 3. Assemble and write --------------------------------------------
  const draft: DraftPlan = {
    callId: outcome.callId,
    patientId: outcome.patientId,
    moduleId: module.id,
    score,
    step,
    safety,
    risks,
    research,
    panel,
    coverage,
    patientRecap: '',
    escalated,
  };
  draft.patientRecap = buildPatientRecap({
    module,
    draft,
    name: context.fullName,
    concerns: outcome.concerns,
  });

  const written = await writeDraftPlan({
    module,
    context,
    draft,
    questionnaireResponse: input.questionnaireResponse,
  });

  logger.info(
    { callId: outcome.callId, carePlanId: written.carePlanId, incomplete: incomplete.length },
    'postcall.complete',
  );

  return { draft, written, context, incomplete };
}
