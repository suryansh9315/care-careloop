/**
 * Runs a scripted check-in against a real patient without placing a phone call.
 *
 * It uses the same tool dispatch and the same post-call pipeline the voice
 * agent uses, so it exercises every live integration end to end and leaves a
 * real draft CarePlan in the review queue. Useful for demos, and for proving
 * the pipeline works without dialling anyone.
 *
 *   npm run demo:call -- --patient <id>
 *   npm run demo:call -- --patient <id> --answers 3,2,2,3,3
 */

import './quiet.js';
import { env, live } from '../config/env.js';
import { getModule } from '../conditions/registry.js';
import { loadPatientContext } from '../orchestration/context.js';
import { runPostCallPipeline } from '../orchestration/postcall.js';
import { createCallState, dispatchTool, toCallOutcome } from '../orchestration/tools.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m\n${'─'.repeat(text.length)}`);
}

const RISK_ANSWERS: Record<string, string> = {
  'risk-exacerbations': 'twice in the last year',
  'risk-reliever-canisters': 'about four canisters',
  'risk-hospitalisation': 'no',
  'risk-adherence-gap': 'yes, I miss a few days most weeks',
  'risk-smoke-exposure': 'no',
  'risk-prior-attempt': 'no',
  'risk-support': 'yes, my partner',
  'risk-substance': 'no',
  'risk-prior-treatment': 'no',
};

const CONCERNS = [
  'I keep waking up at four in the morning coughing and I am shattered at work.',
  'I am worried about being on a steroid inhaler for years.',
];

const QUESTIONS = ['Am I even using my inhaler the right way?'];

async function main(): Promise<void> {
  const patientId = arg('patient') ?? env.seed.patientId;
  if (!patientId) {
    console.error('Pass --patient <id>, or set SEED_PATIENT_ID in .env.');
    process.exit(1);
  }

  const context = await loadPatientContext({ patientId });
  const module = getModule(context.moduleId);

  const answers = (arg('answers') ?? '3,2,2,3,3')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));

  heading(`Scripted check-in — ${context.fullName} (${module.display})`);
  console.log(`Live integrations: ${Object.entries(live).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
  console.log(`Prior scores: ${context.priorScores.map((s) => s.total).join(' → ') || 'none'}`);
  console.log(`Current medications: ${context.currentMedications.map((m) => m.display).join('; ') || 'none'}`);
  console.log('No phone call is placed. This is the post-call pipeline only.\n');

  const state = createCallState(`demo-${Date.now()}`, context);

  for (const [index, item] of module.instrument.items.entries()) {
    const value = answers[index];
    if (value === undefined) continue;
    await dispatchTool({
      state,
      toolCallId: `a-${item.linkId}`,
      name: 'chartLive',
      args: { linkId: item.linkId, value },
    });
    console.log(`  ${item.linkId} → ${value}`);
  }

  for (const question of module.riskQuestions) {
    const value = RISK_ANSWERS[question.linkId];
    if (!value) continue;
    await dispatchTool({
      state,
      toolCallId: `r-${question.linkId}`,
      name: 'chartRiskAnswer',
      args: { linkId: question.linkId, value },
    });
  }

  for (const question of QUESTIONS) {
    const result = await dispatchTool({
      state,
      toolCallId: `q-${question.slice(0, 8)}`,
      name: 'getCareContext',
      args: { question },
    });
    console.log(`\n  Q: ${question}`);
    console.log(`  → ${result.say.split('\n')[0]?.slice(0, 120)}…`);
    console.log(`     source: ${result.detail?.source} (${result.detail?.mock ? 'MOCK' : 'live Moss'})`);
  }

  const coverageResult = await dispatchTool({
    state,
    toolCallId: 'cov',
    name: 'checkCoverage',
    args: { question: 'Will my insurance cover a new inhaler?' },
  });
  console.log(`\n  Q: Will my insurance cover a new inhaler?`);
  console.log(`  → ${coverageResult.say}`);
  console.log(`     ${coverageResult.detail?.mock ? 'MOCK coverage' : 'live Stedi 271'}`);

  for (const concern of CONCERNS) {
    await dispatchTool({
      state,
      toolCallId: `c-${concern.slice(0, 10)}`,
      name: 'recordConcern',
      args: { text: concern },
    });
  }

  await dispatchTool({ state, toolCallId: 'submit', name: 'submitQuestionnaire', args: {} });

  heading('Post-call pipeline');
  const started = Date.now();
  const result = await runPostCallPipeline({
    outcome: toCallOutcome(state),
    questionnaireResponse: state.questionnaireResponse,
    context,
  });
  const { draft } = result;

  console.log(`Completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`Score:     ${draft.score.total} — ${draft.score.bandLabel}${draft.score.crisisOverride ? '  ** CRISIS **' : ''}`);
  console.log(`Step:      ${draft.step.id}`);
  console.log(`Regimen:   ${draft.step.medications.map((m) => m.display).join(', ') || '(none)'}`);
  console.log(`Escalated: ${draft.escalated}`);

  heading('Safety and risk');
  for (const finding of [...draft.safety, ...draft.risks]) {
    console.log(`  [${finding.severity.toUpperCase()}] ${finding.message}`);
  }

  heading('Evidence (live LLM + Moss grounding)');
  for (const finding of draft.research) {
    console.log(`  • ${finding.topic.slice(0, 100)}`);
    console.log(`    ${finding.rationale}`);
    console.log(`    citations: ${finding.citations.map((c) => c.source).join(', ')}`);
    console.log(`    ${finding.grounded ? 'grounded' : 'DETERMINISTIC FALLBACK'}\n`);
  }

  heading(`Expert panel — ${draft.panel.consensus}`);
  for (const review of draft.panel.reviews) {
    console.log(`  ${review.persona}: \x1b[1m${review.stance}\x1b[0m${review.live ? '' : ' (did not run)'}`);
    console.log(`    ${review.rationale}`);
    if (review.suggestedEdit) console.log(`    edit: ${review.suggestedEdit}`);
  }

  if (draft.coverage) {
    heading('Coverage');
    console.log(`  plan=${draft.coverage.planName ?? 'n/a'} covered=${draft.coverage.covered} copay=${draft.coverage.copayUsd ?? 'n/a'} priorAuth=${draft.coverage.priorAuthRequired} mock=${draft.coverage.mock}`);
  }

  heading('Written to Medplum');
  console.log(`  CarePlan            ${result.written.carePlanId} (draft)`);
  console.log(`  MedicationRequests  ${result.written.medicationRequestIds.length} (draft/proposal)`);
  console.log(`  Observations        ${result.written.observationIds.length}`);
  console.log(`  Communications      ${result.written.communicationIds.length}`);
  console.log(`  Review Task         ${result.written.taskId}`);

  if (result.incomplete.length > 0) {
    heading('Incomplete enrichment');
    for (const note of result.incomplete) console.log(`  ! ${note}`);
  } else {
    console.log('\nAll enrichment completed against live services.');
  }

  console.log('\nThe plan is a draft. Open the dashboard review queue to approve it.\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
