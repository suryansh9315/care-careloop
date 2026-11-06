import './test-offline.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearMockStore } from '../integrations/medplum.js';
import type { PatientContext } from '../types.js';
import { createCallState, dispatchTool, parseDob, toCallOutcome } from './tools.js';

const context: PatientContext = {
  patientId: 'p1',
  fullName: 'Jane Doe',
  moduleId: 'asthma',
  currentMedications: [],
  allergies: [],
  triggers: [],
  priorScores: [],
  mock: true,
};

function state() {
  return createCallState('call-1', context);
}

beforeEach(() => clearMockStore());

describe('chartLive', () => {
  it('records a valid answer', async () => {
    const s = state();
    await dispatchTool({ state: s, toolCallId: 'a', name: 'chartLive', args: { linkId: 'act-1', value: 4 } });
    expect(s.answers.get('act-1')).toBe(4);
  });

  it('clamps an out-of-range answer to the item scale', async () => {
    const s = state();
    await dispatchTool({ state: s, toolCallId: 'a', name: 'chartLive', args: { linkId: 'act-1', value: 99 } });
    expect(s.answers.get('act-1')).toBe(5);
  });

  it('rejects a linkId that is not part of the instrument', async () => {
    const s = state();
    await dispatchTool({ state: s, toolCallId: 'a', name: 'chartLive', args: { linkId: 'phq9-1', value: 2 } });
    expect(s.answers.size).toBe(0);
  });

  it('rejects a non-numeric answer', async () => {
    const s = state();
    const result = await dispatchTool({
      state: s,
      toolCallId: 'a',
      name: 'chartLive',
      args: { linkId: 'act-1', value: 'quite a lot' },
    });
    expect(s.answers.size).toBe(0);
    expect(result.say).toContain('not a number');
  });
});

describe('idempotency', () => {
  it('ignores a repeated tool call id', async () => {
    const s = state();
    await dispatchTool({ state: s, toolCallId: 'dup', name: 'recordConcern', args: { text: 'first' } });
    await dispatchTool({ state: s, toolCallId: 'dup', name: 'recordConcern', args: { text: 'second' } });
    expect(s.concerns).toHaveLength(1);
  });

  it('accepts distinct tool call ids', async () => {
    const s = state();
    await dispatchTool({ state: s, toolCallId: 'one', name: 'recordConcern', args: { text: 'first' } });
    await dispatchTool({ state: s, toolCallId: 'two', name: 'recordConcern', args: { text: 'second' } });
    expect(s.concerns).toHaveLength(2);
  });
});

describe('unknown tools', () => {
  it('cannot be invoked by the model', async () => {
    const s = state();
    const result = await dispatchTool({
      state: s,
      toolCallId: 'x',
      name: 'deletePatientRecord',
      args: {},
    });
    expect(result.say).toContain('not available');
  });
});

describe('submitQuestionnaire', () => {
  it('builds a completed response with answers, risks and concerns', async () => {
    const s = state();
    await dispatchTool({ state: s, toolCallId: '1', name: 'chartLive', args: { linkId: 'act-1', value: 3 } });
    await dispatchTool({ state: s, toolCallId: '2', name: 'chartRiskAnswer', args: { linkId: 'risk-hospitalisation', value: 'yes' } });
    await dispatchTool({ state: s, toolCallId: '3', name: 'recordConcern', args: { text: 'breathless on stairs' } });
    await dispatchTool({ state: s, toolCallId: '4', name: 'submitQuestionnaire', args: {} });

    expect(s.submitted).toBe(true);
    expect(s.questionnaireResponse?.status).toBe('completed');
    const linkIds = (s.questionnaireResponse?.item ?? []).map((i) => i.linkId);
    expect(linkIds).toContain('act-1');
    expect(linkIds).toContain('risk-hospitalisation');
    expect(linkIds).toContain('concern-1');
  });

  it('is safe to call twice', async () => {
    const s = state();
    await dispatchTool({ state: s, toolCallId: '1', name: 'chartLive', args: { linkId: 'act-1', value: 3 } });
    await dispatchTool({ state: s, toolCallId: '2', name: 'submitQuestionnaire', args: {} });
    const second = await dispatchTool({ state: s, toolCallId: '3', name: 'submitQuestionnaire', args: {} });
    expect(second.say).toContain('Already submitted');
  });
});

describe('parseDob', () => {
  it('parses many spoken and written forms to the same date', () => {
    for (const form of ['1979-05-14', 'May 14 1979', 'May 14, 1979', '14 May 1979', '5/14/1979', '05/14/1979']) {
      expect(parseDob(form), form).toEqual({ y: 1979, m: 5, d: 14 });
    }
  });

  it('returns undefined when no date can be recovered', () => {
    expect(parseDob('sometime in the spring')).toBeUndefined();
    expect(parseDob('')).toBeUndefined();
  });
});

describe('verifyIdentity', () => {
  const withDob = { ...context, birthDate: '1979-05-14', mock: false } as PatientContext;
  const dobState = () => createCallState('call-dob', withDob);

  it('accepts a matching date in any format the agent might send', async () => {
    const s = dobState();
    const r = await dispatchTool({ state: s, toolCallId: '1', name: 'verifyIdentity', args: { dateOfBirth: 'May 14 1979' } });
    expect(s.dobVerified).toBe(true);
    expect(r.detail?.verified).toBe(true);
  });

  it('gives a second try, then ends after two mismatches', async () => {
    const s = dobState();
    const first = await dispatchTool({ state: s, toolCallId: '1', name: 'verifyIdentity', args: { dateOfBirth: '1990-01-01' } });
    expect(s.dobVerified).toBe(false);
    expect(first.detail?.retry).toBe(true);
    const second = await dispatchTool({ state: s, toolCallId: '2', name: 'verifyIdentity', args: { dateOfBirth: '1988-02-02' } });
    expect(second.detail?.retry).toBe(false);
    expect(s.dobAttempts).toBe(2);
  });

  it('does not strand the patient when no DOB is on file', async () => {
    const s = createCallState('call-nodob', context); // context has no birthDate
    await dispatchTool({ state: s, toolCallId: '1', name: 'verifyIdentity', args: { dateOfBirth: '2000-01-01' } });
    expect(s.dobVerified).toBe(true);
  });
});

describe('toCallOutcome', () => {
  it('captures everything the post-call pipeline needs', async () => {
    const s = state();
    await dispatchTool({ state: s, toolCallId: '1', name: 'chartLive', args: { linkId: 'act-1', value: 3 } });
    await dispatchTool({ state: s, toolCallId: '2', name: 'chartRiskAnswer', args: { linkId: 'risk-hospitalisation', value: 'no' } });

    const outcome = toCallOutcome(s);
    expect(outcome.patientId).toBe('p1');
    expect(outcome.moduleId).toBe('asthma');
    expect(outcome.answers).toEqual([{ linkId: 'act-1', value: 3 }]);
    expect(outcome.riskAnswers).toEqual([{ linkId: 'risk-hospitalisation', value: 'no' }]);
  });
});
