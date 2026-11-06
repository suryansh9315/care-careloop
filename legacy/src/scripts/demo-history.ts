/**
 * Backfills plausible history for a demo patient so the history-aware parts of
 * the product actually have something to be aware of: the score trend, the
 * "last time things were a bit tighter" greeting, the duplicate-therapy and
 * interaction checks, and the CarePlan.replaces revision chain.
 *
 * This writes clearly-labelled demonstration data to a real FHIR server. Point
 * it only at a patient you created for demos.
 *
 *   npm run demo:history -- --patient <id>
 *   npm run demo:history -- --patient <id> --clean   # remove what it wrote
 */

import './quiet.js';
import type {
  CarePlan,
  Communication,
  MedicationRequest,
  Observation,
  QuestionnaireResponse,
  Resource,
} from '@medplum/fhirtypes';
import { env, live } from '../config/env.js';
import { asthmaModule } from '../conditions/asthma.js';
import { createResource, searchResources, updateResource } from '../integrations/medplum.js';
import { loadPatientContext } from '../orchestration/context.js';

const DEMO_TAG = {
  system: 'https://careloop.dev/tags',
  code: 'demo-history',
  display: 'CareLoop demonstration data',
};

const LOINC = 'http://loinc.org';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function monthsAgo(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString();
}

/** Everything written here carries the demo tag so `--clean` can find it. */
function tagged<T extends Resource>(resource: T): T {
  return { ...resource, meta: { ...resource.meta, tag: [DEMO_TAG] } };
}

interface Visit {
  monthsAgo: number;
  items: number[]; // five ACT item answers
}

// A deteriorating trajectory: comfortably controlled a year ago, drifting down.
// This makes the trend chart tell a story and gives the agent something true
// to reference in the greeting.
const VISITS: Visit[] = [
  { monthsAgo: 12, items: [5, 4, 5, 4, 4] }, // 22 — well controlled
  { monthsAgo: 9, items: [4, 4, 4, 4, 4] },  // 20 — well controlled
  { monthsAgo: 6, items: [4, 4, 3, 4, 4] },  // 19 — not well controlled
  { monthsAgo: 3, items: [4, 3, 3, 4, 3] },  // 17 — not well controlled
  { monthsAgo: 1, items: [3, 3, 3, 3, 4] },  // 16 — not well controlled
];

function bandLabel(total: number): string {
  return asthmaModule.bands.find((b) => total >= b.min && total <= b.max)?.label ?? 'Unbanded';
}

async function writeHistory(patientId: string, conditionId: string | undefined): Promise<void> {
  const subject = { reference: `Patient/${patientId}` };
  const created: Record<string, number> = {};
  const bump = (key: string) => { created[key] = (created[key] ?? 0) + 1; };

  // --- Active medications -------------------------------------------------
  // A reliever plus a non-selective beta blocker, so the safety screen has
  // something real to find on the next draft: duplicate reliever therapy and
  // a propranolol / formoterol interaction.
  const medications: Array<{ display: string; code: string; sig: string; route: string }> = [
    {
      display: 'Albuterol sulfate 90 mcg/actuation inhaler',
      code: '745679',
      sig: 'Inhale 2 puffs every 4-6 hours as needed for shortness of breath',
      route: 'inhalation',
    },
    {
      display: 'Fluticasone propionate 110 mcg/actuation inhaler',
      code: '895994',
      sig: 'Inhale 1 puff twice daily',
      route: 'inhalation',
    },
    {
      display: 'Propranolol 40 mg oral tablet',
      code: '866412',
      sig: 'Take 1 tablet by mouth twice daily for migraine prophylaxis',
      route: 'oral',
    },
  ];

  for (const med of medications) {
    await createResource<MedicationRequest>(
      tagged({
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        subject,
        authoredOn: monthsAgo(6),
        medicationCodeableConcept: {
          coding: [{ system: RXNORM, code: med.code, display: med.display }],
          text: med.display,
        },
        dosageInstruction: [{ text: med.sig, route: { text: med.route } }],
      }),
    );
    bump('MedicationRequest');
  }

  // --- Prior check-ins ----------------------------------------------------
  let previousPlanId: string | undefined;

  for (const visit of VISITS) {
    const when = monthsAgo(visit.monthsAgo);
    const total = visit.items.reduce((sum, value) => sum + value, 0);
    const label = bandLabel(total);

    // Item-level Observations.
    for (const [index, item] of asthmaModule.instrument.items.entries()) {
      await createResource<Observation>(
        tagged({
          resourceType: 'Observation',
          status: 'final',
          subject,
          effectiveDateTime: when,
          code: { coding: [{ system: LOINC, code: item.loincCode, display: item.prompt }] },
          valueInteger: visit.items[index] as number,
        }),
      );
      bump('Observation');
    }

    // The total-score Observation is what the dashboard trend reads.
    await createResource<Observation>(
      tagged({
        resourceType: 'Observation',
        status: 'final',
        subject,
        effectiveDateTime: when,
        code: {
          coding: [
            {
              system: LOINC,
              code: asthmaModule.instrument.loincTotalCode,
              display: `${asthmaModule.instrument.name} total score`,
            },
          ],
          text: `${asthmaModule.instrument.name} total score`,
        },
        valueQuantity: { value: total, unit: '{score}' },
        interpretation: [{ text: label }],
      }),
    );
    bump('Observation');

    // The complete answer set stays on the QuestionnaireResponse.
    await createResource<QuestionnaireResponse>(
      tagged({
        resourceType: 'QuestionnaireResponse',
        status: 'completed',
        subject,
        authored: when,
        item: asthmaModule.instrument.items.map((item, index) => ({
          linkId: item.linkId,
          text: item.prompt,
          answer: [{ valueInteger: visit.items[index] as number }],
        })),
      }),
    );
    bump('QuestionnaireResponse');

    await createResource<Communication>(
      tagged({
        resourceType: 'Communication',
        status: 'completed',
        subject,
        category: [{ text: 'careloop-chart' }],
        sent: when,
        payload: [
          {
            contentString: `${asthmaModule.instrument.name} completed by phone check-in → ${total} (${label})`,
          },
        ],
      }),
    );
    bump('Communication');
  }

  // --- The plan currently in force ---------------------------------------
  // Left `active` on purpose: the next draft written after a call will point
  // at it through CarePlan.replaces, which is how the revision chain is shown.
  const activePlan = await createResource<CarePlan>(
    tagged({
      resourceType: 'CarePlan',
      status: 'active',
      intent: 'plan',
      title: 'Asthma plan — Not well controlled (Asthma Control Test (ACT) 16)',
      description:
        'Not well controlled. Continue inhaled corticosteroid and reliever; technique and adherence reviewed at the last visit.',
      subject,
      created: monthsAgo(1),
      period: { start: monthsAgo(1) },
      // Required for the revision chain: the next draft only links a prior
      // plan through `replaces` when both address the same Condition.
      ...(conditionId ? { addresses: [{ reference: `Condition/${conditionId}` }] } : {}),
      note: [{ text: 'Patient goal: get through a normal day without reaching for the reliever.' }],
      activity: [
        {
          detail: {
            kind: 'ServiceRequest',
            status: 'completed',
            description: 'Follow-up review in 6 weeks',
          },
        },
      ],
    }),
  );
  previousPlanId = activePlan.id;
  bump('CarePlan');

  await createResource<Communication>(
    tagged({
      resourceType: 'Communication',
      status: 'completed',
      subject,
      category: [{ text: 'careloop-concern' }],
      sent: monthsAgo(1),
      payload: [
        {
          contentString:
            'Patient concern: I keep waking up around four in the morning coughing and I am shattered at work.',
        },
      ],
    }),
  );
  bump('Communication');

  console.log('\nWrote demonstration history:');
  for (const [type, count] of Object.entries(created).sort()) {
    console.log(`  ${type.padEnd(22)} ${count}`);
  }
  console.log(`\nPrior active CarePlan: ${previousPlanId}`);
}

async function clean(patientId: string): Promise<void> {
  const types = [
    'Observation',
    'MedicationRequest',
    'QuestionnaireResponse',
    'Communication',
    'CarePlan',
  ] as const;

  let removed = 0;
  for (const type of types) {
    const resources = await searchResources(type, {
      subject: `Patient/${patientId}`,
      _tag: `${DEMO_TAG.system}|${DEMO_TAG.code}`,
      _count: '200',
    });
    for (const resource of resources) {
      const isDemo = resource.meta?.tag?.some((tag) => tag.code === DEMO_TAG.code);
      if (!isDemo || !resource.id) continue;
      // Soft removal: entered-in-error preserves the audit trail, which is the
      // right behaviour on a clinical record even for demo data.
      await updateResource({ ...resource, status: 'entered-in-error' } as never);
      removed += 1;
    }
  }
  console.log(`Marked ${removed} demonstration resource(s) as entered-in-error.`);
}

async function main(): Promise<void> {
  const patientId = arg('patient') ?? env.seed.patientId;
  if (!patientId) {
    console.error('Pass --patient <id>, or set SEED_PATIENT_ID in .env.');
    process.exit(1);
  }
  if (!live.medplum) {
    console.error('Medplum credentials are required — this script writes to a real FHIR server.');
    process.exit(1);
  }

  if (process.argv.includes('--clean')) {
    await clean(patientId);
    return;
  }

  const before = await loadPatientContext({ patientId });
  await writeHistory(patientId, before.conditionId);

  // Read the context back exactly as a call would, so the effect is visible.
  const context = await loadPatientContext({ patientId });
  console.log('\nContext a call would now load:');
  console.log(`  ${context.fullName} · ${context.conditionDisplay}`);
  console.log(`  medications: ${context.currentMedications.map((m) => m.display).join(' | ') || 'none'}`);
  console.log(`  allergies:   ${context.allergies.join(', ') || 'none'}`);
  console.log(`  triggers:    ${context.triggers.join(', ') || 'none'}`);
  console.log(
    `  prior scores: ${context.priorScores.map((s) => `${s.total} (${s.date.slice(0, 10)})`).join(', ') || 'none'}`,
  );
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
