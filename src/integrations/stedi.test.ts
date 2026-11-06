import { describe, expect, it } from 'vitest';
import type { MedOrder } from '../types.js';
import { __mapBenefitsForTest as mapBenefits, mockCoverage, spokenCoverageSummary } from './stedi.js';

const icsFormoterol: MedOrder = {
  display: 'Budesonide / formoterol inhaler',
  rxnormCode: '745750',
  role: 'controller',
  sig: '2 puffs BID',
  route: 'inhalation',
  frequency: 'BID',
  prn: false,
  ingredients: ['budesonide', 'formoterol'],
};

describe('271 mapping', () => {
  it('maps an active coverage benefit to covered', () => {
    const result = mapBenefits({ benefitsInformation: [{ code: '1', name: 'Active Coverage' }] });
    expect(result.covered).toBe(true);
    expect(result.mock).toBe(false);
  });

  it('maps a co-payment benefit to a copay amount', () => {
    const result = mapBenefits({
      benefitsInformation: [
        { code: '1' },
        { code: 'B', benefitAmount: '30' },
      ],
    });
    expect(result.copayUsd).toBe(30);
  });

  it('reports not-confirmed when there are no benefit lines', () => {
    const result = mapBenefits({ benefitsInformation: [] });
    expect(result.covered).toBe('not-confirmed');
    expect(result.notes.join(' ')).toContain('no benefit lines');
  });

  it('surfaces payer errors in the notes', () => {
    const result = mapBenefits({ errors: [{ description: 'Invalid member ID' }] });
    expect(result.notes.join(' ')).toContain('Invalid member ID');
  });

  it('trusts a payer authorisation indicator over the heuristic', () => {
    const result = mapBenefits({
      benefitsInformation: [{ code: '1', authorizationOrCertificationRequired: true }],
    });
    expect(result.priorAuthRequired).toBe(true);
    expect(result.notes.join(' ')).toContain('Payer returned an authorisation-required indicator');
  });

  it('labels the step-up prior-auth flag as a heuristic, not a payer answer', () => {
    const result = mapBenefits({ benefitsInformation: [{ code: '1' }] }, icsFormoterol);
    expect(result.priorAuthRequired).toBe(true);
    expect(result.notes.join(' ')).toContain('heuristic');
  });

  it('always warns that eligibility is not a formulary check', () => {
    const result = mapBenefits({ benefitsInformation: [{ code: '1' }] });
    expect(result.notes.join(' ')).toContain('does not confirm formulary coverage');
  });
});

describe('mock coverage', () => {
  it('is clearly labelled as a test result', () => {
    const result = mockCoverage({ payerId: '87726', memberId: 'X' });
    expect(result.mock).toBe(true);
    expect(result.covered).toBe('not-confirmed');
    expect(result.notes.join(' ')).toContain('Deterministic test result');
  });

  it('handles a patient with no coverage on file', () => {
    const result = mockCoverage(undefined);
    expect(result.covered).toBe('not-confirmed');
    expect(result.notes.join(' ')).toContain('No coverage on file');
  });
});

describe('spoken summary', () => {
  it('never promises coverage when it is unconfirmed', () => {
    const spoken = spokenCoverageSummary(mockCoverage({ payerId: '1', memberId: 'X' }));
    expect(spoken).toContain('estimate');
    expect(spoken).not.toMatch(/\bis covered\b/i);
    expect(spoken).toContain('clinician will confirm');
  });

  it('says prior authorisation may be needed rather than that it is required', () => {
    const spoken = spokenCoverageSummary({
      covered: true,
      priorAuthRequired: true,
      notes: [],
      mock: false,
    });
    expect(spoken).toContain('may need prior authorisation');
  });
});
