/**
 * Clears generated artifacts so a demo can be run again from a clean queue.
 *
 * This deliberately does NOT touch Patients, Conditions, Coverage,
 * Questionnaires or PlanDefinitions — the things a clinician set up. It only
 * removes what a call produced: draft plans, their medications, the review
 * tasks, the charting feed and the score observations.
 *
 * Resources are marked `entered-in-error` rather than deleted. On a clinical
 * record the audit trail is the point, and a demo reset is not a good enough
 * reason to break it.
 *
 *   npm run reset                       # every patient, dry run first
 *   npm run reset -- --patient <id>     # one patient
 *   npm run reset -- --apply            # actually write
 */

import './quiet.js';
import type {
  CarePlan,
  Communication,
  MedicationRequest,
  Observation,
  QuestionnaireResponse,
  Task,
} from '@medplum/fhirtypes';
import { live } from '../config/env.js';
import { searchResources, updateResource } from '../integrations/medplum.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

const APPLY = process.argv.includes('--apply');

/** Category prefix that marks a Communication as produced by CareLoop. */
const CARELOOP_PREFIX = 'careloop-';

async function main(): Promise<void> {
  if (!live.medplum) {
    console.error('Medplum credentials are required — this script writes to a real FHIR server.');
    process.exit(1);
  }

  const patientId = arg('patient');
  const scope: Record<string, string> = patientId
    ? { subject: `Patient/${patientId}` }
    : {};
  const label = patientId ? `patient ${patientId}` : 'all patients';

  console.log(`\nCareLoop reset — ${label}`);
  console.log(APPLY ? 'Mode: APPLY (writing)\n' : 'Mode: DRY RUN — pass --apply to write\n');

  const counts: Record<string, number> = {};
  const touched: Array<{ type: string; id: string; label: string }> = [];

  // --- Draft and active plans produced by the pipeline -------------------
  for (const status of ['draft', 'active'] as const) {
    const plans = await searchResources<CarePlan>('CarePlan', { ...scope, status, _count: '200' });
    for (const plan of plans) {
      if (!plan.id) continue;
      touched.push({ type: 'CarePlan', id: plan.id, label: plan.title ?? plan.status ?? '' });

      for (const activity of plan.activity ?? []) {
        const reference = activity.reference?.reference;
        if (!reference?.startsWith('MedicationRequest/')) continue;
        const id = reference.split('/')[1];
        if (id) touched.push({ type: 'MedicationRequest', id, label: reference });
      }
    }
  }

  // --- Review tasks -------------------------------------------------------
  const tasks = await searchResources<Task>('Task', { ...scope, _count: '200' });
  for (const task of tasks) {
    if (task.id) touched.push({ type: 'Task', id: task.id, label: task.description ?? '' });
  }

  // --- Charting feed and review artifacts --------------------------------
  const communications = await searchResources<Communication>('Communication', {
    ...scope,
    _count: '400',
  });
  for (const communication of communications) {
    const isCareLoop = communication.category?.some((c) => c.text?.startsWith(CARELOOP_PREFIX));
    if (isCareLoop && communication.id) {
      touched.push({
        type: 'Communication',
        id: communication.id,
        label: communication.category?.[0]?.text ?? '',
      });
    }
  }

  // --- Scores and questionnaire responses --------------------------------
  const observations = await searchResources<Observation>('Observation', { ...scope, _count: '400' });
  for (const observation of observations) {
    if (observation.id) {
      touched.push({ type: 'Observation', id: observation.id, label: observation.code?.coding?.[0]?.code ?? '' });
    }
  }

  const responses = await searchResources<QuestionnaireResponse>('QuestionnaireResponse', {
    ...scope,
    _count: '200',
  });
  for (const response of responses) {
    if (response.id) touched.push({ type: 'QuestionnaireResponse', id: response.id, label: '' });
  }

  for (const entry of touched) counts[entry.type] = (counts[entry.type] ?? 0) + 1;

  for (const [type, count] of Object.entries(counts).sort()) {
    console.log(`  ${type.padEnd(22)} ${count}`);
  }
  if (touched.length === 0) {
    console.log('  (nothing to clear)\n');
    return;
  }

  if (!APPLY) {
    console.log(`\n${touched.length} resource(s) would be marked entered-in-error.`);
    console.log('Re-run with --apply to write.\n');
    return;
  }

  let done = 0;
  for (const entry of touched) {
    try {
      const [existing] = await searchResources(entry.type as never, { _id: entry.id });
      if (!existing) continue;
      await updateResource({ ...(existing as object), status: 'entered-in-error' } as never);
      done += 1;
    } catch (error) {
      console.warn(`  ! ${entry.type}/${entry.id}: ${String(error).slice(0, 90)}`);
    }
  }

  console.log(`\nMarked ${done} resource(s) entered-in-error.`);
  console.log('Patients, Conditions, Coverage and Questionnaires were left untouched.\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
