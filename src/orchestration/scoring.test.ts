import { describe, expect, it } from 'vitest';
import { asthmaModule } from '../conditions/asthma.js';
import { depressionModule } from '../conditions/depression.js';
import { completeness, scoreInstrument, stepForBand } from './scoring.js';

const act = (values: number[]) =>
  values.map((value, index) => ({ linkId: `act-${index + 1}`, value }));
const phq = (values: number[]) =>
  values.map((value, index) => ({ linkId: `phq9-${index + 1}`, value }));

describe('scoreInstrument — ACT', () => {
  it('sums the five items and bands them', () => {
    expect(scoreInstrument(asthmaModule, act([5, 5, 5, 5, 5]))).toMatchObject({
      total: 25,
      band: 'controlled',
    });
    expect(scoreInstrument(asthmaModule, act([4, 4, 4, 3, 3]))).toMatchObject({
      total: 18,
      band: 'partial',
    });
    expect(scoreInstrument(asthmaModule, act([3, 2, 2, 3, 3]))).toMatchObject({
      total: 13,
      band: 'poor',
    });
    expect(scoreInstrument(asthmaModule, act([1, 1, 1, 1, 1]))).toMatchObject({
      total: 5,
      band: 'very-poor',
    });
  });

  it('is stable at every band boundary', () => {
    const boundaries: Array<[number, string]> = [
      [10, 'very-poor'],
      [11, 'poor'],
      [15, 'poor'],
      [16, 'partial'],
      [19, 'partial'],
      [20, 'controlled'],
    ];
    for (const [total, expected] of boundaries) {
      // Distribute the total across the five items.
      const base = Math.floor(total / 5);
      const values = [base, base, base, base, total - base * 4];
      expect(scoreInstrument(asthmaModule, act(values)).band).toBe(expected);
    }
  });

  it('clamps out-of-range and non-numeric answers instead of throwing', () => {
    const result = scoreInstrument(asthmaModule, act([99, -4, Number.NaN, 3, 3]));
    expect(result.total).toBeGreaterThanOrEqual(asthmaModule.instrument.minTotal);
    expect(result.total).toBeLessThanOrEqual(asthmaModule.instrument.maxTotal);
  });

  it('ignores answers whose linkId is not part of the instrument', () => {
    const withNoise = [...act([4, 4, 4, 4, 4]), { linkId: 'not-an-item', value: 99 }];
    expect(scoreInstrument(asthmaModule, withNoise).total).toBe(20);
  });

  it('is deterministic — identical answers give an identical plan', () => {
    const answers = act([3, 2, 2, 3, 3]);
    const first = scoreInstrument(asthmaModule, answers);
    const second = scoreInstrument(asthmaModule, answers);
    expect(first).toEqual(second);
    expect(stepForBand(asthmaModule, first.band)).toBe(stepForBand(asthmaModule, second.band));
  });
});

describe('scoreInstrument — PHQ-9', () => {
  it('bands by total when item 9 is zero', () => {
    expect(scoreInstrument(depressionModule, phq([0, 0, 0, 0, 0, 0, 0, 0, 0]))).toMatchObject({
      total: 0,
      band: 'minimal',
    });
    expect(scoreInstrument(depressionModule, phq([2, 2, 1, 2, 1, 1, 1, 1, 0]))).toMatchObject({
      total: 11,
      band: 'moderate',
    });
    expect(scoreInstrument(depressionModule, phq([3, 3, 3, 3, 3, 3, 2, 1, 0]))).toMatchObject({
      total: 21,
      band: 'severe',
    });
  });

  it('overrides the band whenever item 9 is above zero, even at a low total', () => {
    const result = scoreInstrument(depressionModule, phq([0, 0, 0, 0, 0, 0, 0, 0, 1]));
    expect(result.total).toBe(1);
    expect(result.crisisOverride).toBe(true);
    expect(result.band).toBe('crisis');
  });

  it('drafts no medication on the crisis pathway', () => {
    const result = scoreInstrument(depressionModule, phq([3, 3, 3, 3, 3, 3, 3, 3, 3]));
    const step = stepForBand(depressionModule, result.band);
    expect(step.medications).toHaveLength(0);
    expect(step.urgent).toBe(true);
    expect(step.referralRequired).toBe(true);
  });
});

describe('stepForBand', () => {
  it('returns the module step for a known band', () => {
    expect(stepForBand(asthmaModule, 'poor').id).toBe('poor');
  });

  it('falls back to the most cautious band rather than throwing', () => {
    // "higher-is-better" instrument → most cautious is the lowest band.
    expect(stepForBand(asthmaModule, 'no-such-band').id).toBe('very-poor');
    // "higher-is-worse" instrument → most cautious is the highest band.
    expect(stepForBand(depressionModule, 'no-such-band').id).toBe('severe');
  });
});

describe('completeness', () => {
  it('reports a partial call as partial', () => {
    expect(completeness(asthmaModule, act([4, 4, 4]))).toEqual({
      answered: 3,
      total: 5,
      complete: false,
    });
    expect(completeness(asthmaModule, act([4, 4, 4, 4, 4])).complete).toBe(true);
  });
});
