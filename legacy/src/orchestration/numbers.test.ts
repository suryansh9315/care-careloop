import { describe, expect, it } from 'vitest';
import { asthmaModule } from '../conditions/asthma.js';
import type { ScoreResult } from '../types.js';
import { isAffirmative, parseCount } from './numbers.js';
import { evaluateRisk } from './safety.js';

describe('parseCount', () => {
  it('reads digits, including hedged and ranged answers', () => {
    expect(parseCount('4')).toBe(4);
    expect(parseCount('about 4 canisters')).toBe(4);
    expect(parseCount('maybe 2 or 3 times')).toBe(2);
    expect(parseCount('4-5 times')).toBe(4);
  });

  it('reads spoken number words — the common case on a phone call', () => {
    expect(parseCount('about four canisters')).toBe(4);
    expect(parseCount('twice in the last year')).toBe(2);
    expect(parseCount('just once')).toBe(1);
    expect(parseCount('a couple of times')).toBe(2);
    expect(parseCount('three, I think')).toBe(3);
    expect(parseCount('a dozen')).toBe(12);
  });

  it('reads compound tens', () => {
    expect(parseCount('twenty five')).toBe(25);
    expect(parseCount('thirty-two')).toBe(32);
  });

  it('reads zero from words meaning none', () => {
    expect(parseCount('none at all')).toBe(0);
    expect(parseCount('never')).toBe(0);
  });

  it('treats vague high answers as above threshold rather than discarding them', () => {
    expect(parseCount('loads of them')).toBe(99);
    expect(parseCount('too many to count')).toBe(99);
  });

  it('returns undefined when there is genuinely no number', () => {
    expect(parseCount('I would rather not say')).toBeUndefined();
    expect(parseCount('')).toBeUndefined();
  });
});

describe('isAffirmative', () => {
  it('recognises affirmatives', () => {
    for (const answer of ['yes', 'yeah', 'yep', 'sure', 'I have, once', 'sometimes', 'a few days a week']) {
      expect(isAffirmative(answer), answer).toBe(true);
    }
  });

  it('recognises negatives, including ones containing affirmative-looking words', () => {
    for (const answer of ['no', 'nope', 'never', 'not really', 'no, I have never', "haven't, no"]) {
      expect(isAffirmative(answer), answer).toBe(false);
    }
  });

  it('treats an empty or non-committal answer as not affirmative', () => {
    expect(isAffirmative('')).toBe(false);
    expect(isAffirmative('hmm')).toBe(false);
  });
});

describe('risk rules with spoken answers', () => {
  const controlled: ScoreResult = {
    total: 20,
    band: 'controlled',
    bandLabel: 'Well controlled',
    crisisOverride: false,
  };

  // This is the regression: "about four canisters" previously parsed as 0,
  // which silently dropped a critical reliever-overuse finding.
  it('flags reliever overuse when the count is spoken as a word', () => {
    const findings = evaluateRisk(
      asthmaModule,
      [{ linkId: 'risk-reliever-canisters', value: 'about four canisters' }],
      controlled,
    );
    expect(findings.some((f) => f.severity === 'critical' && f.code === 'reliever-overuse')).toBe(true);
  });

  it('flags frequent exacerbations when spoken as "twice"', () => {
    const findings = evaluateRisk(
      asthmaModule,
      [{ linkId: 'risk-exacerbations', value: 'twice in the last year' }],
      controlled,
    );
    expect(findings.some((f) => f.severity === 'critical' && f.code === 'frequent-exacerbations')).toBe(true);
  });

  it('does not flag overuse when the patient says none', () => {
    const findings = evaluateRisk(
      asthmaModule,
      [{ linkId: 'risk-reliever-canisters', value: 'none at all' }],
      controlled,
    );
    expect(findings.some((f) => f.code === 'reliever-overuse')).toBe(false);
  });

  it('does not flag a negative answer as a prior hospitalisation', () => {
    const findings = evaluateRisk(
      asthmaModule,
      [{ linkId: 'risk-hospitalisation', value: 'no, I have never been admitted' }],
      controlled,
    );
    expect(findings.some((f) => f.code === 'prior-hospitalisation')).toBe(false);
  });
});
