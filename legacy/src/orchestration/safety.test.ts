import { describe, expect, it } from 'vitest';
import { asthmaModule } from '../conditions/asthma.js';
import { depressionModule } from '../conditions/depression.js';
import type { MedOrder, ScoreResult } from '../types.js';
import { checkRegimenSafety, evaluateRisk, shouldEscalate } from './safety.js';

const budesonideFormoterol: MedOrder = {
  display: 'Budesonide 160 mcg / formoterol 4.5 mcg inhaler',
  rxnormCode: '745750',
  role: 'controller',
  sig: '2 puffs twice daily',
  route: 'inhalation',
  frequency: 'BID',
  prn: false,
  ingredients: ['budesonide', 'formoterol'],
};

const sertraline: MedOrder = {
  display: 'Sertraline 50 mg oral tablet',
  rxnormCode: '312940',
  role: 'primary',
  sig: '1 tablet daily',
  route: 'oral',
  frequency: 'daily',
  prn: false,
  ingredients: ['sertraline'],
};

describe('checkRegimenSafety', () => {
  it('flags an allergy match as critical', () => {
    const findings = checkRegimenSafety([budesonideFormoterol], {
      allergies: ['formoterol'],
      currentMedications: [],
    });
    const critical = findings.filter((f) => f.severity === 'critical');
    expect(critical).toHaveLength(1);
    expect(critical[0]?.code).toBe('allergy-match');
  });

  it('does not flag an unrelated allergy', () => {
    const findings = checkRegimenSafety([budesonideFormoterol], {
      allergies: ['penicillin'],
      currentMedications: [],
    });
    expect(findings.some((f) => f.code === 'allergy-match')).toBe(false);
  });

  it('flags duplicate therapy as a warning, not a blocker', () => {
    const findings = checkRegimenSafety([budesonideFormoterol], {
      allergies: [],
      currentMedications: [
        { display: 'Budesonide 80 mcg inhaler', ingredients: ['budesonide'] },
      ],
    });
    const duplicate = findings.find((f) => f.code === 'duplicate-therapy');
    expect(duplicate?.severity).toBe('warning');
  });

  it('flags a known interaction against an active medication', () => {
    const findings = checkRegimenSafety([sertraline], {
      allergies: [],
      currentMedications: [{ display: 'Tramadol 50 mg oral tablet', ingredients: ['tramadol'] }],
    });
    expect(findings.some((f) => f.code === 'interaction')).toBe(true);
  });

  it('notes an empty regimen rather than returning silence', () => {
    const findings = checkRegimenSafety([], { allergies: [], currentMedications: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
  });

  it('does not emit the same finding twice', () => {
    const findings = checkRegimenSafety([budesonideFormoterol], {
      allergies: ['formoterol', 'formoterol'],
      currentMedications: [],
    });
    expect(findings.filter((f) => f.code === 'allergy-match')).toHaveLength(1);
  });
});

describe('risk rules', () => {
  const controlledScore: ScoreResult = {
    total: 20,
    band: 'controlled',
    bandLabel: 'Well controlled',
    crisisOverride: false,
  };

  it('treats reliever overuse as critical even when the score looks fine', () => {
    const findings = evaluateRisk(
      asthmaModule,
      [{ linkId: 'risk-reliever-canisters', value: 'about 4 I think' }],
      controlledScore,
    );
    expect(findings.some((f) => f.severity === 'critical' && f.code === 'reliever-overuse')).toBe(true);
  });

  it('treats a prior asthma hospitalisation as critical', () => {
    const findings = evaluateRisk(
      asthmaModule,
      [{ linkId: 'risk-hospitalisation', value: 'yes, once' }],
      controlledScore,
    );
    expect(findings.some((f) => f.code === 'prior-hospitalisation')).toBe(true);
  });

  it('treats a prior suicide attempt as critical', () => {
    const findings = evaluateRisk(
      depressionModule,
      [{ linkId: 'risk-prior-attempt', value: 'yes' }],
      { total: 6, band: 'mild', bandLabel: 'Mild', crisisOverride: false },
    );
    expect(findings.some((f) => f.severity === 'critical' && f.code === 'prior-attempt')).toBe(true);
  });

  it('returns a warning rather than throwing when the rules fail', () => {
    const broken = { ...asthmaModule, riskRules: () => { throw new Error('boom'); } };
    const findings = evaluateRisk(broken, [], controlledScore);
    expect(findings[0]?.code).toBe('risk-rules-failed');
  });
});

describe('shouldEscalate', () => {
  it('escalates on an urgent protocol step', () => {
    expect(shouldEscalate({ urgentStep: true, safety: [], risks: [] })).toBe(true);
  });

  it('escalates on a critical risk finding even when the step is not urgent', () => {
    expect(
      shouldEscalate({
        urgentStep: false,
        safety: [],
        risks: [{ severity: 'critical', code: 'reliever-overuse', message: '' }],
      }),
    ).toBe(true);
  });

  it('does not escalate on warnings alone', () => {
    expect(
      shouldEscalate({
        urgentStep: false,
        safety: [{ severity: 'warning', code: 'duplicate-therapy', message: '' }],
        risks: [{ severity: 'warning', code: 'adherence-gap', message: '' }],
      }),
    ).toBe(false);
  });
});
