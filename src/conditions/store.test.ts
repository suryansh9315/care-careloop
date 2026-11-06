import { describe, expect, it } from 'vitest';
import { asthmaModule } from './asthma.js';
import { depressionModule } from './depression.js';
import {
  storedModuleSchema,
  toRuntimeModule,
  toStoredModule,
  validateStoredModule,
} from './store.js';

describe('round trip', () => {
  it('serialises and revalidates every built-in module', () => {
    for (const module of [asthmaModule, depressionModule]) {
      const stored = toStoredModule(module);
      expect(storedModuleSchema.safeParse(stored).success, module.id).toBe(true);
      expect(validateStoredModule(stored), module.id).toEqual([]);
    }
  });

  it('restores behaviour from the built-in it extends', () => {
    const stored = toStoredModule(depressionModule);
    const runtime = toRuntimeModule(stored, depressionModule);

    // The crisis override is a function and cannot be serialised — it has to
    // come back from the base module or the crisis pathway silently vanishes.
    expect(runtime.crisisOverride?.([{ linkId: 'phq9-9', value: 1 }])).toBe(true);
    expect(runtime.crisisBandId).toBe('crisis');
    expect(runtime.riskRules([{ linkId: 'risk-prior-attempt', value: 'yes' }], {
      total: 6, band: 'mild', bandLabel: 'Mild', crisisOverride: false,
    })).not.toHaveLength(0);
  });

  it('still runs without a behavioural base, contributing no risk findings', () => {
    const runtime = toRuntimeModule(toStoredModule(asthmaModule), undefined);
    expect(runtime.riskRules([], { total: 13, band: 'poor', bandLabel: 'Poor', crisisOverride: false })).toEqual([]);
    expect(runtime.researchTopicTemplate({
      conditionDisplay: 'Asthma', band: 'Poor', total: 13, triggers: [],
    })).toContain('Asthma');
  });
});

describe('clinical validation', () => {
  const base = () => toStoredModule(asthmaModule);

  it('rejects a gap between bands — a score could fall in none', () => {
    const module = base();
    const poor = module.bands.find((b) => b.id === 'poor');
    if (poor) poor.min = 13;
    expect(validateStoredModule(module).join(' ')).toContain('not contiguous');
  });

  it('rejects a band with no protocol step', () => {
    const module = base();
    delete module.steps.poor;
    expect(validateStoredModule(module).join(' ')).toContain('no protocol step');
  });

  it('rejects bands that do not cover the instrument range', () => {
    const module = base();
    const lowest = module.bands.find((b) => b.id === 'very-poor');
    if (lowest) lowest.min = 7;
    expect(validateStoredModule(module).join(' ')).toContain('lowest band');
  });

  it('rejects a module with no safety reviewer', () => {
    const module = base();
    module.experts = module.experts.map((expert) => ({ ...expert, safetyReviewer: false }));
    expect(validateStoredModule(module).join(' ')).toContain('safety reviewer');
  });

  it('rejects duplicate item linkIds', () => {
    const module = base();
    const first = module.instrument.items[0];
    const second = module.instrument.items[1];
    if (first && second) second.linkId = first.linkId;
    expect(validateStoredModule(module).join(' ')).toContain('duplicate item');
  });

  it('rejects an inverted instrument range', () => {
    const module = base();
    module.instrument.minTotal = 30;
    expect(validateStoredModule(module).join(' ')).toContain('minTotal');
  });

  it('rejects an inverted band', () => {
    const module = base();
    const band = module.bands[0];
    if (band) { band.min = 20; band.max = 5; }
    expect(validateStoredModule(module).length).toBeGreaterThan(0);
  });
});

describe('shape validation', () => {
  it('rejects a medication without an RxNorm code', () => {
    const module = base();
    const step = module.steps.poor;
    if (step?.medications[0]) step.medications[0].rxnormCode = '';
    expect(storedModuleSchema.safeParse(module).success).toBe(false);
  });

  it('rejects an unknown medication role', () => {
    const module = base();
    const step = module.steps.poor;
    if (step?.medications[0]) (step.medications[0] as { role: string }).role = 'wonder-drug';
    expect(storedModuleSchema.safeParse(module).success).toBe(false);
  });

  it('rejects a module with no emergency rules', () => {
    const module = base();
    module.emergencyRules = [];
    expect(storedModuleSchema.safeParse(module).success).toBe(false);
  });

  function base() {
    return toStoredModule(asthmaModule);
  }
});
