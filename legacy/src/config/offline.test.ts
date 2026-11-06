import { describe, expect, it } from 'vitest';
import { goOffline, isLive, isOffline, live } from './env.js';

/**
 * Regression for a real incident.
 *
 * `npm run simulate` is documented as a complete pipeline with zero
 * credentials, but it read the per-integration flags directly. On a machine
 * with a populated `.env` it wrote its fixture patients to the real FHIR
 * server, leaving draft CarePlans in the clinician's review queue pointing at
 * `Patient/sim-patient-asthma` — a patient that does not exist. It also spent
 * real Stedi and LLM calls on a synthetic scenario.
 *
 * This file runs in its own worker because `goOffline()` is process-global.
 */
describe('the global offline switch', () => {
  it('starts off, so the bridge is unaffected', () => {
    expect(isOffline()).toBe(false);
  });

  it('forces every integration to its mock at once', () => {
    goOffline();
    expect(isOffline()).toBe(true);
    for (const integration of Object.keys(live) as Array<keyof typeof live>) {
      expect(isLive(integration), `${integration} should be mocked offline`).toBe(false);
    }
  });

  it('is one-way — nothing can quietly re-enable a live call mid-run', () => {
    goOffline();
    goOffline();
    expect(isLive('medplum')).toBe(false);
    expect(isLive('twilio')).toBe(false);
  });
});
