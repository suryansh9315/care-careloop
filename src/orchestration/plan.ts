import type {
  CarePlan,
  CarePlanActivity,
  Communication,
  MedicationRequest,
  Observation,
  Patient,
  QuestionnaireResponse,
  Reference,
  Task,
} from '@medplum/fhirtypes';
import type { ConditionModule } from '../conditions/types.js';
import { createResource, searchResources, updateResource } from '../integrations/medplum.js';
import { logger } from '../logger.js';
import type { Concern, DraftPlan, MedOrder, PatientContext } from '../types.js';

const LOINC = 'http://loinc.org';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';

/**
 * Translates the deterministic draft into FHIR.
 *
 * Everything written here is a *draft*. CarePlan.status is `draft` and every
 * MedicationRequest.status is `draft` with intent `proposal`. Nothing becomes
 * active without the clinician approval transaction at the bottom of this file.
 */

function patientRef(patientId: string): Reference<Patient> {
  return { reference: `Patient/${patientId}` };
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/**
 * The patient-facing recap.
 *
 * The patient should leave the call with something, so this reflects back what
 * they actually said before anything else — being heard is the part they can
 * verify, and it is what makes the rest credible. Nothing here is framed as a
 * prescription, because none of it is one yet.
 */
export function buildPatientRecap(input: {
  module: ConditionModule;
  draft: Pick<DraftPlan, 'score' | 'step' | 'escalated'>;
  name: string;
  concerns?: Concern[];
}): string {
  const { module, draft, name } = input;
  const lines: string[] = [];
  const firstName = name.split(' ')[0] ?? name;

  lines.push(`Thanks for taking the time today, ${firstName}.`);

  // Reflect back at most two concerns: more than that stops being a recap and
  // starts being a recitation.
  const concerns = (input.concerns ?? []).slice(0, 2);
  if (concerns.length > 0) {
    lines.push(
      `You told us about ${concerns.map((c) => `"${c.text.replace(/\s+/g, ' ').trim()}"`).join(' and ')} — that has been written down for your clinician.`,
    );
  }

  lines.push(
    `Your ${module.instrument.name} score today was ${draft.score.total}, which we read as "${draft.score.bandLabel}".`,
  );
  lines.push(`What your clinician will look at: ${draft.step.patientGoal}`);

  if (draft.step.medications.length > 0) {
    lines.push(
      'Suggested for your clinician to review (not yet prescribed): ' +
        draft.step.medications.map((m) => `${m.display} — ${m.sig}`).join('; ') +
        '.',
    );
  } else {
    lines.push('No new medication is being suggested from this check-in.');
  }

  lines.push(`A follow-up is planned in about ${draft.step.followUpDays} days.`);
  if (draft.escalated) {
    lines.push('Because of what you told us today, someone from the care team will contact you sooner.');
  }
  lines.push(
    'Nothing here is a prescription yet — a clinician reviews and approves everything first.',
  );
  lines.push(
    'If your symptoms get suddenly worse before then, do not wait for the follow-up. Get urgent care.',
  );

  return lines.join(' ');
}

function medicationRequest(
  med: MedOrder,
  patientId: string,
  conditionId: string | undefined,
): MedicationRequest {
  return {
    resourceType: 'MedicationRequest',
    status: 'draft',
    intent: 'proposal',
    subject: patientRef(patientId),
    ...(conditionId ? { reasonReference: [{ reference: `Condition/${conditionId}` }] } : {}),
    medicationCodeableConcept: {
      coding: [{ system: RXNORM, code: med.rxnormCode, display: med.display }],
      text: med.display,
    },
    dosageInstruction: [
      {
        text: med.sig,
        asNeededBoolean: med.prn,
        route: { text: med.route },
        timing: { code: { text: med.frequency } },
      },
    ],
    ...(med.quantity || med.refills !== undefined || med.durationDays
      ? {
          dispenseRequest: {
            ...(med.quantity ? { quantity: { value: med.quantity } } : {}),
            ...(med.refills !== undefined ? { numberOfRepeatsAllowed: med.refills } : {}),
            ...(med.durationDays
              ? { expectedSupplyDuration: { value: med.durationDays, unit: 'days', system: 'http://unitsofmeasure.org', code: 'd' } }
              : {}),
          },
        }
      : {}),
  };
}

function communication(
  patientId: string,
  category: string,
  topic: string,
  payload: string,
): Communication {
  return {
    resourceType: 'Communication',
    status: 'completed',
    subject: patientRef(patientId),
    category: [{ text: category }],
    topic: { text: topic },
    sent: new Date().toISOString(),
    payload: [{ contentString: payload }],
  };
}

export interface WrittenPlan {
  carePlanId?: string;
  medicationRequestIds: string[];
  observationIds: string[];
  taskId?: string;
  communicationIds: string[];
}

export async function writeDraftPlan(input: {
  module: ConditionModule;
  context: PatientContext;
  draft: DraftPlan;
  questionnaireResponse?: QuestionnaireResponse;
}): Promise<WrittenPlan> {
  const { module, context, draft } = input;
  const patientId = context.patientId;
  const written: WrittenPlan = { medicationRequestIds: [], observationIds: [], communicationIds: [] };
  const now = new Date().toISOString();

  // --- Final Observations: item values plus the total score --------------
  const answersByLinkId = new Map(
    (input.questionnaireResponse?.item ?? [])
      .map((item) => [item.linkId, item.answer?.[0]?.valueInteger])
      .filter(([, value]) => typeof value === 'number') as Array<[string, number]>,
  );

  for (const item of module.instrument.items) {
    const value = answersByLinkId.get(item.linkId);
    if (value === undefined) continue;
    const observation = await createResource<Observation>({
      resourceType: 'Observation',
      status: 'final',
      subject: patientRef(patientId),
      effectiveDateTime: now,
      code: { coding: [{ system: LOINC, code: item.loincCode, display: item.prompt }] },
      valueInteger: value,
    });
    if (observation.id) written.observationIds.push(observation.id);
  }

  const totalObservation = await createResource<Observation>({
    resourceType: 'Observation',
    status: 'final',
    subject: patientRef(patientId),
    effectiveDateTime: now,
    code: {
      coding: [{ system: LOINC, code: module.instrument.loincTotalCode, display: `${module.instrument.name} total score` }],
      text: `${module.instrument.name} total score`,
    },
    valueQuantity: { value: draft.score.total, unit: '{score}' },
    interpretation: [{ text: draft.score.bandLabel }],
  });
  if (totalObservation.id) written.observationIds.push(totalObservation.id);

  // --- Draft medication proposals ---------------------------------------
  const medicationRefs: Array<Reference<MedicationRequest>> = [];
  for (const med of draft.step.medications) {
    const created = await createResource(medicationRequest(med, patientId, context.conditionId));
    if (created.id) {
      written.medicationRequestIds.push(created.id);
      medicationRefs.push({ reference: `MedicationRequest/${created.id}`, display: med.display });
    }
  }

  // --- Revision chain: link the prior active plan for this condition -----
  const priorActive = await searchResources<CarePlan>('CarePlan', {
    patient: `Patient/${patientId}`,
    status: 'active',
  });
  const replaces = priorActive
    .filter((plan) => !context.conditionId || plan.addresses?.some((a) => a.reference?.endsWith(context.conditionId!)))
    .map((plan) => ({ reference: `CarePlan/${plan.id}` }));

  // --- The draft CarePlan ------------------------------------------------
  const carePlan = await createResource<CarePlan>({
    resourceType: 'CarePlan',
    status: 'draft',
    intent: 'plan',
    title: `${module.display} plan — ${draft.score.bandLabel} (${module.instrument.name} ${draft.score.total})`,
    description: draft.step.summary,
    subject: patientRef(patientId),
    created: now,
    period: { start: now, end: isoDaysFromNow(draft.step.followUpDays) },
    ...(context.conditionId ? { addresses: [{ reference: `Condition/${context.conditionId}` }] } : {}),
    ...(replaces.length ? { replaces } : {}),
    goal: [],
    activity: [
      ...medicationRefs.map((reference): CarePlanActivity => ({ reference })),
      {
        detail: {
          kind: 'ServiceRequest' as const,
          status: 'not-started' as const,
          description: `Follow-up review in ${draft.step.followUpDays} days`,
          scheduledTiming: { repeat: { boundsPeriod: { start: isoDaysFromNow(draft.step.followUpDays) } } },
        },
      },
      ...(draft.step.referralRequired
        ? [
            {
              detail: {
                kind: 'ServiceRequest' as const,
                status: 'not-started' as const,
                description: `Specialist referral indicated for ${module.display}`,
              },
            },
          ]
        : []),
    ],
    note: [{ text: `Patient goal: ${draft.step.patientGoal}` }],
  });
  written.carePlanId = carePlan.id;

  // --- Review artifacts as Communications --------------------------------
  const artifacts: Array<[string, string, string]> = [
    [
      'careloop-research',
      'Evidence synthesis',
      draft.research
        .map(
          (finding) =>
            `TOPIC: ${finding.topic}\n${finding.rationale}\nCitations: ${finding.citations
              .map((c) => `${c.title} (${c.source}${c.url ? ` — ${c.url}` : ''})`)
              .join('; ')}${finding.grounded ? '' : '\n[Deterministic fallback — evidence synthesis did not run]'}`,
        )
        .join('\n\n') || 'No research findings were produced.',
    ],
    [
      'careloop-panel',
      `Expert panel — ${draft.panel.consensus}`,
      draft.panel.reviews
        .map(
          (review) =>
            `${review.persona} (${review.specialty}) — ${review.stance}${review.live ? '' : ' [did not run]'}\n${review.rationale}${
              review.suggestedEdit ? `\nSuggested edit: ${review.suggestedEdit}` : ''
            }`,
        )
        .join('\n\n'),
    ],
    [
      'careloop-safety',
      'Safety and risk findings',
      [
        ...draft.safety.map((f) => `[${f.severity}] ${f.code}: ${f.message}`),
        ...draft.risks.map((f) => `[${f.severity}] ${f.code}: ${f.message}`),
      ].join('\n') || 'No safety or risk findings.',
    ],
    ['careloop-recap', 'Patient recap', draft.patientRecap],
  ];

  if (draft.coverage) {
    artifacts.push([
      'careloop-coverage',
      'Coverage and eligibility',
      [
        `Plan: ${draft.coverage.planName ?? 'unknown'}`,
        `Covered: ${draft.coverage.covered}`,
        `Estimated copay: ${draft.coverage.copayUsd !== undefined ? `$${draft.coverage.copayUsd}` : 'unknown'}`,
        `Prior authorisation: ${draft.coverage.priorAuthRequired}`,
        draft.coverage.mock ? 'SOURCE: deterministic mock — no live payer response.' : 'SOURCE: live 271 response.',
        ...draft.coverage.notes,
      ].join('\n'),
    ]);
  }

  for (const [category, topic, payload] of artifacts) {
    const created = await createResource(communication(patientId, category, topic, payload));
    if (created.id) written.communicationIds.push(created.id);
  }

  // --- Review task -------------------------------------------------------
  const task = await createResource<Task>({
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    priority: draft.escalated ? 'urgent' : 'routine',
    description: draft.escalated
      ? `URGENT: review ${module.display} plan for ${context.fullName} — ${draft.score.bandLabel} (${draft.score.total})`
      : `Review ${module.display} plan for ${context.fullName} — ${draft.score.bandLabel} (${draft.score.total})`,
    for: patientRef(patientId),
    authoredOn: now,
    ...(carePlan.id ? { focus: { reference: `CarePlan/${carePlan.id}` } } : {}),
    ...(draft.escalated
      ? { restriction: { period: { end: isoDaysFromNow(1) } } }
      : { restriction: { period: { end: isoDaysFromNow(3) } } }),
  });
  written.taskId = task.id;

  logger.info(
    {
      patientId,
      carePlanId: written.carePlanId,
      medications: written.medicationRequestIds.length,
      escalated: draft.escalated,
      consensus: draft.panel.consensus,
    },
    'plan.draft.written',
  );

  return written;
}

/**
 * Clinician approval.
 *
 * Deliberately ordered so that a partial failure leaves the plan *less*
 * active rather than more: medications are activated first, the plan second,
 * the task last. A critical safety finding must be acknowledged upstream — the
 * caller passes `acknowledgedCriticalFlags` and this function refuses without it.
 */
export async function approvePlan(input: {
  carePlanId: string;
  approverReference?: string;
  hasCriticalFlag: boolean;
  acknowledgedCriticalFlags: boolean;
}): Promise<{ approved: boolean; reason?: string }> {
  if (input.hasCriticalFlag && !input.acknowledgedCriticalFlags) {
    return {
      approved: false,
      reason: 'A critical safety flag must be explicitly acknowledged before approval.',
    };
  }

  const plans = await searchResources<CarePlan>('CarePlan', { _id: input.carePlanId });
  const plan = plans[0];
  if (!plan) return { approved: false, reason: 'CarePlan not found.' };

  for (const activity of plan.activity ?? []) {
    const reference = activity.reference?.reference;
    if (!reference?.startsWith('MedicationRequest/')) continue;
    const id = reference.split('/')[1];
    if (!id) continue;
    const requests = await searchResources<MedicationRequest>('MedicationRequest', { _id: id });
    const request = requests[0];
    if (request) {
      await updateResource<MedicationRequest>({ ...request, status: 'active', intent: 'order' });
    }
  }

  const now = new Date().toISOString();
  await updateResource<CarePlan>({
    ...plan,
    status: 'active',
    note: [
      ...(plan.note ?? []),
      {
        text: `Approved at ${now}${input.approverReference ? ` by ${input.approverReference}` : ''}${
          input.hasCriticalFlag ? ' with critical safety flag acknowledged' : ''
        }.`,
      },
    ],
  });

  const tasks = await searchResources<Task>('Task', { focus: `CarePlan/${input.carePlanId}` });
  for (const task of tasks) {
    if (task.status === 'requested') {
      await updateResource<Task>({ ...task, status: 'completed', lastModified: now });
    }
  }

  logger.info({ carePlanId: input.carePlanId }, 'plan.approved');
  return { approved: true };
}

/**
 * Undo an approval, returning the plan to the review queue.
 *
 * Approval activates real medication orders, so a misclick needs a way back.
 * This is a *reversal*, not an erasure: the plan and its orders go back to
 * draft and the review task is reopened, and a note records that the approval
 * was withdrawn and by whom. Nothing is deleted, so the record still shows the
 * approval happened and was undone.
 */
export async function unapprovePlan(input: {
  carePlanId: string;
  reverserReference?: string;
  reason?: string;
}): Promise<{ reverted: boolean; reason?: string }> {
  const plans = await searchResources<CarePlan>('CarePlan', { _id: input.carePlanId });
  const plan = plans[0];
  if (!plan) return { reverted: false, reason: 'CarePlan not found.' };
  if (plan.status !== 'active') {
    return { reverted: false, reason: `Only an approved plan can be reverted (this one is ${plan.status}).` };
  }

  for (const activity of plan.activity ?? []) {
    const reference = activity.reference?.reference;
    if (!reference?.startsWith('MedicationRequest/')) continue;
    const id = reference.split('/')[1];
    if (!id) continue;
    const requests = await searchResources<MedicationRequest>('MedicationRequest', { _id: id });
    const request = requests[0];
    if (request) {
      await updateResource<MedicationRequest>({ ...request, status: 'draft', intent: 'proposal' });
    }
  }

  const now = new Date().toISOString();
  await updateResource<CarePlan>({
    ...plan,
    status: 'draft',
    note: [
      ...(plan.note ?? []),
      {
        text:
          `Approval withdrawn at ${now}` +
          `${input.reverserReference ? ` by ${input.reverserReference}` : ''}` +
          `${input.reason ? `: ${input.reason}` : '.'}`,
        time: now,
      },
    ],
  });

  // Reopen the review task so the plan shows as outstanding work again.
  const tasks = await searchResources<Task>('Task', { focus: `CarePlan/${input.carePlanId}` });
  for (const task of tasks) {
    if (task.status === 'completed') {
      await updateResource<Task>({ ...task, status: 'requested', lastModified: now });
    }
  }

  logger.info({ carePlanId: input.carePlanId }, 'plan.approval.withdrawn');
  return { reverted: true };
}
