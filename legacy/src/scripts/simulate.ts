/**
 * Offline end-to-end simulation.
 *
 * Runs the whole pipeline — context, live-call tool dispatch, scoring, safety,
 * research, panel, coverage, FHIR write — with no credentials at all. Every
 * external result in this mode is a labelled mock; the point is to exercise
 * the deterministic core and the fallback paths, not to prove the integrations
 * work.
 *
 *   npm run simulate            # asthma, poorly controlled
 *   npm run simulate depression # PHQ-9 with the crisis item endorsed
 */

import './offline.js';
import { getModule } from '../conditions/registry.js';
import { clearMockStore, createResource, mockStoreSnapshot } from '../integrations/medplum.js';
import { buildIntakeFlow } from '../orchestration/flow.js';
import { compareRenderings } from '../orchestration/renderers.js';
import { runPostCallPipeline } from '../orchestration/postcall.js';
import { createCallState, dispatchTool, toCallOutcome } from '../orchestration/tools.js';
import type { PatientContext } from '../types.js';

const moduleId = process.argv[2] ?? 'asthma';

const SCENARIOS: Record<
  string,
  {
    context: PatientContext;
    answers: Array<[string, number]>;
    risks: Array<[string, string]>;
    concerns: string[];
    questions: string[];
    coverageQuestion?: string;
  }
> = {
  asthma: {
    context: {
      patientId: 'sim-patient-asthma',
      fullName: 'Jane Doe',
      birthDate: '1985-03-14',
      phone: '+15555550123',
      conditionId: 'sim-condition-asthma',
      conditionDisplay: 'Asthma',
      moduleId: 'asthma',
      currentMedications: [
        { display: 'Albuterol sulfate 90 mcg inhaler', ingredients: ['albuterol'] },
        { display: 'Propranolol 40 mg oral tablet', ingredients: ['propranolol'] },
      ],
      allergies: ['penicillin'],
      triggers: ['house dust mite', 'cold air'],
      priorScores: [
        { date: '2026-02-10', total: 19, band: 'Not well controlled' },
        { date: '2026-05-11', total: 17, band: 'Not well controlled' },
      ],
      coverage: { payerId: '87726', payerName: 'Test Payer', memberId: 'MEMBER123' },
      mock: true,
    },
    // Total 13 → "poor" band → medium-dose MART + reliever.
    answers: [
      ['act-1', 3],
      ['act-2', 2],
      ['act-3', 2],
      ['act-4', 3],
      ['act-5', 3],
    ],
    risks: [
      ['risk-exacerbations', 'twice I think'],
      ['risk-reliever-canisters', 'about 4'],
      ['risk-hospitalisation', 'no'],
      ['risk-adherence-gap', 'yes, a few days a week'],
      ['risk-smoke-exposure', 'no'],
    ],
    concerns: [
      'I get really breathless walking up the stairs at work and it is embarrassing',
      'I am worried about using steroids long term',
    ],
    questions: ['Am I using my inhaler right? I never know if I am doing it properly'],
    coverageQuestion: 'Will my insurance cover a new inhaler?',
  },

  depression: {
    context: {
      patientId: 'sim-patient-depression',
      fullName: 'Alex Rivera',
      birthDate: '1992-11-02',
      phone: '+15555550199',
      conditionId: 'sim-condition-depression',
      conditionDisplay: 'Major depressive disorder',
      moduleId: 'depression',
      currentMedications: [{ display: 'Tramadol 50 mg oral tablet', ingredients: ['tramadol'] }],
      allergies: [],
      triggers: [],
      priorScores: [{ date: '2026-04-02', total: 11, band: 'Moderate' }],
      coverage: undefined,
      mock: true,
    },
    // Item 9 above zero → crisis override regardless of the total.
    answers: [
      ['phq9-1', 3],
      ['phq9-2', 3],
      ['phq9-3', 2],
      ['phq9-4', 3],
      ['phq9-5', 2],
      ['phq9-6', 3],
      ['phq9-7', 2],
      ['phq9-8', 1],
      ['phq9-9', 1],
    ],
    risks: [
      ['risk-prior-attempt', 'no'],
      ['risk-support', 'not really, no'],
      ['risk-substance', 'yes, drinking more'],
      ['risk-prior-treatment', 'yes, years ago'],
    ],
    concerns: ['I cannot get out of bed most mornings and I have started missing work'],
    questions: ['How long do antidepressants take to work?'],
  },
};

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m\n${'─'.repeat(text.length)}`);
}

async function main(): Promise<void> {
  const scenario = SCENARIOS[moduleId];
  if (!scenario) {
    console.error(`Unknown scenario "${moduleId}". Try: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  clearMockStore();
  const module = getModule(moduleId);

  heading(`CareLoop simulation — ${module.display}`);
  console.log(`Patient: ${scenario.context.fullName}`);
  console.log(`Instrument: ${module.instrument.name}`);
  console.log('All external results in this run are mocks.\n');

  // Seed the patient so the FHIR writes have something to reference.
  await createResource({
    resourceType: 'Patient',
    id: scenario.context.patientId,
    name: [{ text: scenario.context.fullName }],
  });

  // Both renderings come from the one flow spec. Printing them side by side is
  // the A/B foundation: if these ever disagree about the interview, the flow
  // is the single place to fix it.
  heading('Orchestration renderings (one flow, two modes)');
  const flow = buildIntakeFlow(module);
  const comparison = compareRenderings(module, scenario.context);
  console.log(`  flow nodes:        ${comparison.stateNodes} (start "${comparison.stateStartNode}")`);
  console.log(`  prompt mode:       ${comparison.promptChars} chars, ${comparison.promptTools} tools available at once`);
  console.log(`  state mode:        ${comparison.stateStartTools} tools gated at the start node, ${comparison.maxNodeTools} max on any node`);
  console.log(`  emergency rules:   ${flow.emergencyRules.length} (rendered ahead of the flow in both modes)`);
  console.log(`  active mode:       ${process.env.ORCH_MODE === 'state' ? 'state' : 'prompt'}`);

  const state = createCallState(`sim-${Date.now()}`, scenario.context);

  heading('Live call');
  for (const [linkId, value] of scenario.answers) {
    const item = module.instrument.items.find((i) => i.linkId === linkId);
    console.log(`  Maya: ${item?.prompt}`);
    console.log(`  Patient: ${value}`);
    const result = await dispatchTool({ state, toolCallId: `t-${linkId}`, name: 'chartLive', args: { linkId, value } });
    console.log(`  → ${result.say}\n`);
  }

  for (const [linkId, value] of scenario.risks) {
    await dispatchTool({ state, toolCallId: `r-${linkId}`, name: 'chartRiskAnswer', args: { linkId, value } });
  }
  console.log(`  Recorded ${scenario.risks.length} future-risk answers.\n`);

  for (const question of scenario.questions) {
    console.log(`  Patient: ${question}`);
    const result = await dispatchTool({ state, toolCallId: `q-${question.slice(0, 8)}`, name: 'getCareContext', args: { question } });
    console.log(`  → ${result.say.split('\n')[0]}\n`);
  }

  if (scenario.coverageQuestion) {
    console.log(`  Patient: ${scenario.coverageQuestion}`);
    const result = await dispatchTool({
      state,
      toolCallId: 'cov-1',
      name: 'checkCoverage',
      args: { question: scenario.coverageQuestion },
    });
    console.log(`  → ${result.say}\n`);
  }

  for (const concern of scenario.concerns) {
    await dispatchTool({ state, toolCallId: `c-${concern.slice(0, 8)}`, name: 'recordConcern', args: { text: concern } });
  }
  console.log(`  Recorded ${scenario.concerns.length} open concerns.`);

  await dispatchTool({ state, toolCallId: 'submit-1', name: 'submitQuestionnaire', args: {} });

  heading('Post-call pipeline');
  const result = await runPostCallPipeline({
    outcome: toCallOutcome(state),
    questionnaireResponse: state.questionnaireResponse,
    context: scenario.context,
  });

  const { draft } = result;
  console.log(`Score:      ${draft.score.total} — ${draft.score.bandLabel}${draft.score.crisisOverride ? '  ** CRISIS OVERRIDE **' : ''}`);
  console.log(`Step:       ${draft.step.id} — ${draft.step.summary}`);
  console.log(`Regimen:    ${draft.step.medications.map((m) => m.display).join(', ') || '(none)'}`);
  console.log(`Follow-up:  ${draft.step.followUpDays} days   Referral: ${draft.step.referralRequired}   Escalated: ${draft.escalated}`);

  heading('Safety and risk');
  for (const finding of [...draft.safety, ...draft.risks]) {
    console.log(`  [${finding.severity.toUpperCase()}] ${finding.message}`);
  }

  heading('Evidence');
  for (const finding of draft.research) {
    console.log(`  • ${finding.topic}`);
    console.log(`    ${finding.rationale}`);
    console.log(`    ${finding.grounded ? 'grounded in clinic corpus' : 'DETERMINISTIC FALLBACK — synthesis did not run'}\n`);
  }

  heading(`Expert panel — ${draft.panel.consensus}`);
  for (const review of draft.panel.reviews) {
    console.log(`  ${review.persona}: ${review.stance}${review.live ? '' : ' (did not run)'}`);
  }

  if (draft.coverage) {
    heading('Coverage');
    console.log(`  covered=${draft.coverage.covered}  copay=${draft.coverage.copayUsd ?? 'unknown'}  priorAuth=${draft.coverage.priorAuthRequired}  mock=${draft.coverage.mock}`);
  }

  heading('Patient recap');
  console.log(`  ${draft.patientRecap}`);

  heading('FHIR written (in-memory mock store)');
  const counts = new Map<string, number>();
  for (const resource of mockStoreSnapshot()) {
    counts.set(resource.resourceType, (counts.get(resource.resourceType) ?? 0) + 1);
  }
  for (const [type, count] of [...counts].sort()) {
    console.log(`  ${type.padEnd(22)} ${count}`);
  }

  if (result.incomplete.length > 0) {
    heading('Incomplete enrichment (shown to the clinician)');
    for (const note of result.incomplete) console.log(`  ! ${note}`);
  }

  console.log('\nNothing above is active. The CarePlan is a draft awaiting clinician approval.\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
