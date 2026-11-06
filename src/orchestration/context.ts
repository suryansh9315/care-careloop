import type {
  AllergyIntolerance,
  Condition,
  Coverage,
  MedicationRequest,
  Observation,
  Patient,
} from '@medplum/fhirtypes';
import { env } from '../config/env.js';
import { moduleForCondition, tryGetModule } from '../conditions/registry.js';
import { readResource, searchResources, usingLiveMedplum } from '../integrations/medplum.js';
import { logger } from '../logger.js';
import type {
  CoverageInfo,
  MedicationSummary,
  PatientContext,
  ScoreHistoryEntry,
} from '../types.js';

/**
 * Builds the `PatientContext` the call and the post-call pipeline both run on.
 *
 * This is the only place patient history is assembled. It goes to the
 * server-side prompt and, where configured, the evidence prompts — never to
 * Moss. Every field here should be justifiable as minimum-necessary: identity
 * for verification, condition and medications for safety, prior scores for
 * trajectory, coverage for eligibility.
 */

/**
 * A patient with no coded condition, or one whose condition matches no module.
 *
 * This is a routine, recoverable situation — the clinician just has to say
 * which treatment to run — so it is a distinct type rather than a generic
 * Error. Surfacing it as a 500 "could not start call" tells the clinician
 * nothing they can act on.
 */
export class UnresolvedModuleError extends Error {
  readonly patientId: string;
  readonly hasCondition: boolean;

  constructor(patientId: string, hasCondition: boolean) {
    super(
      hasCondition
        ? `Patient ${patientId} has a condition on file that matches no treatment module. Choose a treatment for this call.`
        : `Patient ${patientId} has no condition on file. Choose a treatment for this call.`,
    );
    this.name = 'UnresolvedModuleError';
    this.patientId = patientId;
    this.hasCondition = hasCondition;
  }
}

function patientName(patient: Patient | undefined): string {
  const name = patient?.name?.[0];
  if (!name) return 'the patient';
  return [name.given?.join(' '), name.family].filter(Boolean).join(' ') || 'the patient';
}

function medicationSummary(request: MedicationRequest): MedicationSummary {
  const concept = request.medicationCodeableConcept;
  const coding = concept?.coding?.[0];
  const display = coding?.display ?? concept?.text ?? 'Unnamed medication';
  return {
    display,
    rxnormCode: coding?.code,
    ingredients: display
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((token) => token.length > 3),
  };
}

function coverageInfo(coverage: Coverage | undefined): CoverageInfo | undefined {
  if (!coverage) return undefined;
  const payerId =
    coverage.payor?.[0]?.identifier?.value ??
    coverage.class?.find((c) => c.type?.coding?.[0]?.code === 'plan')?.value ??
    '';
  const memberId = coverage.subscriberId ?? coverage.identifier?.[0]?.value ?? '';
  if (!payerId && !memberId) return undefined;
  return {
    payerId,
    payerName: coverage.payor?.[0]?.display,
    memberId,
    // Subscriber name/DOB are only carried when present; they are never logged.
    subscriberFirstName: undefined,
    subscriberLastName: undefined,
    subscriberDob: undefined,
  };
}

function scoreHistory(observations: Observation[], bandLabelFor: (total: number) => string): ScoreHistoryEntry[] {
  return observations
    .filter((obs) => typeof obs.valueQuantity?.value === 'number' || typeof obs.valueInteger === 'number')
    .map((obs) => ({
      date: obs.effectiveDateTime ?? obs.issued ?? new Date().toISOString(),
      total: (obs.valueQuantity?.value ?? obs.valueInteger) as number,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => ({ ...entry, band: bandLabelFor(entry.total) }));
}

export async function loadPatientContext(input: {
  patientId: string;
  moduleId?: string;
  /** Subscriber details for a complete 270, when supplied out of band. */
  coverageOverride?: Partial<CoverageInfo>;
}): Promise<PatientContext> {
  const { patientId } = input;
  const mock = !usingLiveMedplum();

  const patient = await readResource<Patient>('Patient', patientId);

  const [conditions, medications, allergies, coverages] = await Promise.all([
    searchResources<Condition>('Condition', { patient: `Patient/${patientId}`, 'clinical-status': 'active' }),
    searchResources<MedicationRequest>('MedicationRequest', {
      patient: `Patient/${patientId}`,
      status: 'active',
    }),
    searchResources<AllergyIntolerance>('AllergyIntolerance', { patient: `Patient/${patientId}` }),
    searchResources<Coverage>('Coverage', { patient: `Patient/${patientId}`, status: 'active' }),
  ]);

  const anchor = conditions[0];
  const module =
    tryGetModule(input.moduleId) ??
    moduleForCondition({
      moduleId: input.moduleId,
      icd10: anchor?.code?.coding?.find((c) => c.system?.includes('icd-10'))?.code,
      snomed: anchor?.code?.coding?.find((c) => c.system?.includes('snomed'))?.code,
    });

  if (!module) {
    throw new UnresolvedModuleError(patientId, Boolean(anchor));
  }

  // Prior finalised total-score Observations, oldest to newest.
  const priorScoreObservations = await searchResources<Observation>('Observation', {
    patient: `Patient/${patientId}`,
    code: `http://loinc.org|${module.instrument.loincTotalCode}`,
    status: 'final',
    _sort: 'date',
    _count: '20',
  });

  const bandLabelFor = (total: number): string =>
    module.bands.find((b) => total >= b.min && total <= b.max)?.label ?? 'Unbanded';

  const triggers = allergies
    .filter((a) => a.category?.includes('environment'))
    .map((a) => a.code?.text ?? a.code?.coding?.[0]?.display ?? '')
    .filter(Boolean);

  const drugAllergies = allergies
    .filter((a) => !a.category?.length || a.category.includes('medication'))
    .map((a) => a.code?.text ?? a.code?.coding?.[0]?.display ?? '')
    .filter(Boolean);

  const baseCoverage = coverageInfo(coverages[0]);

  // Precedence: explicit override, then the Coverage resource, then the test
  // subscriber from configuration. The last tier exists because a FHIR Coverage
  // carries member id but not subscriber name/DOB, and a 270 needs both — see
  // the note on `env.stedi.subscriber`.
  const subscriberDefaults = env.stedi.subscriber;
  const coverage: CoverageInfo | undefined =
    baseCoverage || input.coverageOverride
      ? {
          payerId: input.coverageOverride?.payerId ?? baseCoverage?.payerId ?? '',
          payerName: input.coverageOverride?.payerName ?? baseCoverage?.payerName,
          memberId:
            input.coverageOverride?.memberId ??
            baseCoverage?.memberId ??
            subscriberDefaults.memberId,
          subscriberFirstName:
            input.coverageOverride?.subscriberFirstName ||
            baseCoverage?.subscriberFirstName ||
            subscriberDefaults.firstName ||
            undefined,
          subscriberLastName:
            input.coverageOverride?.subscriberLastName ||
            baseCoverage?.subscriberLastName ||
            subscriberDefaults.lastName ||
            undefined,
          subscriberDob:
            input.coverageOverride?.subscriberDob ||
            baseCoverage?.subscriberDob ||
            subscriberDefaults.dob ||
            undefined,
        }
      : undefined;

  const context: PatientContext = {
    patientId,
    fullName: patientName(patient),
    birthDate: patient?.birthDate,
    phone: patient?.telecom?.find((t) => t.system === 'phone')?.value,
    conditionId: anchor?.id,
    conditionDisplay: anchor?.code?.text ?? anchor?.code?.coding?.[0]?.display ?? module.display,
    moduleId: module.id,
    currentMedications: medications.map(medicationSummary),
    allergies: drugAllergies,
    triggers,
    priorScores: scoreHistory(priorScoreObservations, bandLabelFor),
    coverage,
    mock,
  };

  logger.info(
    {
      patientId,
      moduleId: module.id,
      medications: context.currentMedications.length,
      allergies: context.allergies.length,
      priorScores: context.priorScores.length,
      mock,
    },
    'context.loaded',
  );

  return context;
}
