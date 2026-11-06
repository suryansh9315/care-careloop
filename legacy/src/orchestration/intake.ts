import type {
  AllergyIntolerance,
  Condition,
  Coverage,
  Patient,
  Questionnaire,
} from '@medplum/fhirtypes';
import { getModule } from '../conditions/registry.js';
import type { ConditionModule } from '../conditions/types.js';
import { createResource, searchResources } from '../integrations/medplum.js';
import { logger } from '../logger.js';

/**
 * Intake creates the minimum record needed to run a call: a Patient, an anchor
 * Condition, an optional Coverage, and the module's shared Questionnaire.
 *
 * The Questionnaire is condition-scoped and reused across patients — it is the
 * instrument, not a per-patient artifact — so it is looked up before creation.
 */

export interface IntakeRequest {
  moduleId: string;
  givenName: string;
  familyName: string;
  /** YYYY-MM-DD */
  birthDate: string;
  phone: string;
  gender?: 'male' | 'female' | 'other' | 'unknown';
  city?: string;
  state?: string;
  coverage?: {
    payerId: string;
    payerName?: string;
    memberId: string;
    subscriberFirstName?: string;
    subscriberLastName?: string;
    subscriberDob?: string;
  };
  allergies?: string[];
  triggers?: string[];
}

export interface IntakeResult {
  patientId: string;
  conditionId: string;
  questionnaireId: string;
  coverageId?: string;
  moduleId: string;
}

function questionnaireFor(module: ConditionModule): Questionnaire {
  return {
    resourceType: 'Questionnaire',
    status: 'active',
    name: module.instrument.id,
    title: module.instrument.name,
    code: [
      {
        system: 'http://loinc.org',
        code: module.instrument.loincPanelCode,
        display: module.instrument.name,
      },
    ],
    subjectType: ['Patient'],
    item: [
      ...module.instrument.items.map((item) => ({
        linkId: item.linkId,
        text: item.prompt,
        type: 'integer' as const,
        required: true,
        code: [{ system: 'http://loinc.org', code: item.loincCode, display: item.prompt }],
      })),
      ...module.riskQuestions.map((question) => ({
        linkId: question.linkId,
        text: question.prompt,
        type: 'string' as const,
        required: false,
      })),
    ],
  };
}

async function ensureQuestionnaire(module: ConditionModule): Promise<string> {
  const existing = await searchResources<Questionnaire>('Questionnaire', {
    name: module.instrument.id,
    status: 'active',
  });
  const found = existing.find((q) => q.name === module.instrument.id);
  if (found?.id) return found.id;

  const created = await createResource(questionnaireFor(module));
  if (!created.id) throw new Error('Questionnaire creation returned no id');
  logger.info({ module: module.id, questionnaireId: created.id }, 'intake.questionnaire.created');
  return created.id;
}

export async function createIntake(request: IntakeRequest): Promise<IntakeResult> {
  const module = getModule(request.moduleId);

  const patient = await createResource<Patient>({
    resourceType: 'Patient',
    active: true,
    name: [{ given: [request.givenName], family: request.familyName }],
    birthDate: request.birthDate,
    telecom: [{ system: 'phone', value: request.phone, use: 'mobile' }],
    ...(request.gender ? { gender: request.gender } : {}),
    ...(request.city || request.state
      ? { address: [{ city: request.city, state: request.state }] }
      : {}),
  });
  if (!patient.id) throw new Error('Patient creation returned no id');

  const condition = await createResource<Condition>({
    resourceType: 'Condition',
    clinicalStatus: {
      coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' },
      ],
    },
    verificationStatus: {
      coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' },
      ],
    },
    code: {
      coding: [
        { system: 'http://hl7.org/fhir/sid/icd-10', code: module.icd10, display: module.display },
        { system: 'http://snomed.info/sct', code: module.snomed, display: module.display },
      ],
      text: module.display,
    },
    subject: { reference: `Patient/${patient.id}` },
    recordedDate: new Date().toISOString(),
  });
  if (!condition.id) throw new Error('Condition creation returned no id');

  let coverageId: string | undefined;
  if (request.coverage?.memberId) {
    const coverage = await createResource<Coverage>({
      resourceType: 'Coverage',
      status: 'active',
      beneficiary: { reference: `Patient/${patient.id}` },
      subscriberId: request.coverage.memberId,
      payor: [
        {
          display: request.coverage.payerName ?? request.coverage.payerId,
          identifier: { value: request.coverage.payerId },
        },
      ],
    });
    coverageId = coverage.id;
  }

  for (const allergy of request.allergies ?? []) {
    await createResource<AllergyIntolerance>({
      resourceType: 'AllergyIntolerance',
      clinicalStatus: {
        coding: [
          { system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' },
        ],
      },
      category: ['medication'],
      patient: { reference: `Patient/${patient.id}` },
      code: { text: allergy },
    });
  }

  for (const trigger of request.triggers ?? []) {
    await createResource<AllergyIntolerance>({
      resourceType: 'AllergyIntolerance',
      clinicalStatus: {
        coding: [
          { system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' },
        ],
      },
      category: ['environment'],
      patient: { reference: `Patient/${patient.id}` },
      code: { text: trigger },
    });
  }

  const questionnaireId = await ensureQuestionnaire(module);

  logger.info(
    { patientId: patient.id, conditionId: condition.id, module: module.id },
    'intake.created',
  );

  return {
    patientId: patient.id,
    conditionId: condition.id,
    questionnaireId,
    coverageId,
    moduleId: module.id,
  };
}
