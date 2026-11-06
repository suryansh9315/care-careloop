import { env, isLive } from '../config/env.js';
import { logger, maskId } from '../logger.js';
import type { CoverageInfo, CoverageResult, MedOrder } from '../types.js';

/**
 * Real-time eligibility via Stedi's 270/271 endpoint.
 *
 * Scope warning that must survive into every UI string: a 270/271 eligibility
 * check is *not* a formulary query. It tells us whether coverage is active and
 * what the benefit lines say; it does not guarantee that a specific NDC will
 * be paid. Everything this module returns is an estimate for workflow support.
 */

const ELIGIBILITY_PATH = '/change/medicalnetwork/eligibility/v3';

interface Stedi271Benefit {
  code?: string;
  name?: string;
  coverageLevelCode?: string;
  serviceTypeCodes?: string[];
  insuranceTypeCode?: string;
  planCoverageDescription?: string;
  benefitAmount?: string;
  benefitPercent?: string;
  authorizationOrCertificationRequired?: boolean;
  inPlanNetworkIndicatorCode?: string;
}

interface Stedi271Response {
  planStatus?: Array<{ statusCode?: string; planDetails?: string; serviceTypeCodes?: string[] }>;
  benefitsInformation?: Stedi271Benefit[];
  errors?: Array<{ code?: string; description?: string }>;
  subscriber?: { planDescription?: string };
}

/** Deterministic, clearly-patterned mock. Never presented as a real result. */
export function mockCoverage(coverage: CoverageInfo | undefined, medication?: MedOrder): CoverageResult {
  const notes = [
    'Deterministic test result — no live payer response was obtained.',
    'Eligibility does not confirm formulary coverage for a specific product.',
  ];
  if (!coverage) {
    return {
      planName: undefined,
      covered: 'not-confirmed',
      priorAuthRequired: 'unknown',
      notes: ['No coverage on file for this patient.', ...notes],
      mock: true,
    };
  }
  return {
    planName: coverage.payerName ? `${coverage.payerName} (test)` : 'Test plan',
    covered: 'not-confirmed',
    copayUsd: 25,
    priorAuthRequired: stepUpNeedsPriorAuth(medication) ? true : 'unknown',
    notes,
    mock: true,
  };
}

/**
 * Transparent step-up heuristic. Combination ICS-formoterol inhalers are the
 * products most often gated behind prior authorisation, so a step-up to one is
 * flagged even when the payer sends no explicit authorisation indicator. This
 * is a heuristic, and it is labelled as one in the returned notes.
 */
function stepUpNeedsPriorAuth(medication?: MedOrder): boolean {
  if (!medication) return false;
  const ingredients = medication.ingredients ?? [];
  return ingredients.includes('formoterol') && ingredients.length > 1;
}

function mapBenefits(body: Stedi271Response, medication?: MedOrder): CoverageResult {
  const benefits = body.benefitsInformation ?? [];
  const notes: string[] = [];

  const activeBenefit = benefits.some((b) => b.code === '1');
  const activePlan = (body.planStatus ?? []).some((s) => s.statusCode === '1');
  const covered: CoverageResult['covered'] = activeBenefit || activePlan ? true : 'not-confirmed';

  const copayBenefit = benefits.find((b) => b.code === 'B' && b.benefitAmount);
  const copayUsd = copayBenefit?.benefitAmount ? Number(copayBenefit.benefitAmount) : undefined;

  const payerAuthFlag = benefits.some((b) => b.authorizationOrCertificationRequired === true);
  const heuristicAuth = stepUpNeedsPriorAuth(medication);
  let priorAuthRequired: CoverageResult['priorAuthRequired'];
  if (payerAuthFlag) {
    priorAuthRequired = true;
    notes.push('Payer returned an authorisation-required indicator.');
  } else if (heuristicAuth) {
    priorAuthRequired = true;
    notes.push(
      'Prior authorisation flagged by CareLoop’s step-up heuristic for combination ICS-formoterol, not by the payer response.',
    );
  } else {
    priorAuthRequired = 'unknown';
  }

  const planName =
    body.subscriber?.planDescription ??
    body.planStatus?.find((s) => s.planDetails)?.planDetails ??
    benefits.find((b) => b.planCoverageDescription)?.planCoverageDescription;

  if (benefits.length === 0) {
    notes.push('Payer returned no benefit lines; coverage could not be confirmed.');
  }
  for (const error of body.errors ?? []) {
    if (error.description) notes.push(`Payer error: ${error.description}`);
  }
  notes.push('Eligibility does not confirm formulary coverage for a specific product.');

  return { planName, covered, copayUsd, priorAuthRequired, notes, mock: false };
}

export async function checkEligibility(
  coverage: CoverageInfo | undefined,
  medication?: MedOrder,
): Promise<CoverageResult> {
  if (!isLive('stedi') || !coverage) {
    return mockCoverage(coverage, medication);
  }

  const payload = {
    controlNumber: String(Date.now()).slice(-9),
    tradingPartnerServiceId: coverage.payerId || env.stedi.payerId,
    provider: {
      organizationName: env.stedi.providerName,
      npi: env.stedi.providerNpi,
    },
    subscriber: {
      firstName: coverage.subscriberFirstName,
      lastName: coverage.subscriberLastName,
      dateOfBirth: coverage.subscriberDob?.replace(/-/g, ''),
      memberId: coverage.memberId,
    },
    encounter: {
      serviceTypeCodes: [env.stedi.serviceType],
    },
  };

  try {
    const response = await fetch(`${env.stedi.baseUrl}${ELIGIBILITY_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: env.stedi.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status, member: maskId(coverage.memberId) },
        'stedi.http.error',
      );
      return mockCoverage(coverage, medication);
    }

    const body = (await response.json()) as Stedi271Response;
    const result = mapBenefits(body, medication);
    logger.info(
      { covered: result.covered, priorAuth: result.priorAuthRequired, member: maskId(coverage.memberId) },
      'stedi.eligibility.ok',
    );
    return result;
  } catch (error) {
    logger.warn({ err: String(error), member: maskId(coverage.memberId) }, 'stedi.request.failed');
    return mockCoverage(coverage, medication);
  }
}

/** Patient-facing phrasing. Must never promise that something is covered. */
export function spokenCoverageSummary(result: CoverageResult): string {
  const parts: string[] = [];
  if (result.covered === true) {
    parts.push(`It looks like your ${result.planName ?? 'plan'} coverage is active.`);
  } else {
    parts.push('I could not confirm your coverage from here, so please treat this as an estimate.');
  }
  if (typeof result.copayUsd === 'number') {
    parts.push(`Your estimated copay would be around ${result.copayUsd} dollars.`);
  }
  if (result.priorAuthRequired === true) {
    parts.push('This medication may need prior authorisation, which the clinic would handle for you.');
  }
  parts.push('Your clinician will confirm the final cost with the pharmacy.');
  return parts.join(' ');
}

export { mapBenefits as __mapBenefitsForTest };
