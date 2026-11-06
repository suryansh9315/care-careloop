import { describe, expect, it } from 'vitest';
import { asthmaModule } from '../conditions/asthma.js';
import type { PatientContext } from '../types.js';
import { buildIntakeFlow } from './flow.js';
import { renderStateNode } from './renderers.js';
import { FlowStateMachine } from './statemachine.js';

const context: PatientContext = {
  patientId: 'p1',
  fullName: 'Jane Doe',
  birthDate: '1985-03-14',
  moduleId: 'asthma',
  conditionDisplay: 'Asthma',
  currentMedications: [{ display: 'Albuterol inhaler' }],
  allergies: [],
  triggers: [],
  priorScores: [],
  mock: true,
};

const machine = () => new FlowStateMachine(asthmaModule, context);

describe('FlowStateMachine', () => {
  it('starts on the greeting node', () => {
    const sm = machine();
    expect(sm.currentNodeId).toBe('greeting');
    expect(sm.view()?.prompt).toContain('CURRENT STEP');
  });

  it('advances the greeting after the first patient turn — the opener already covered the intro', () => {
    const sm = machine();
    expect(sm.onUserTurn()?.nodeId).toBe('verify');
  });

  it('does not treat a greeting repair as identity confirmation', () => {
    const sm = machine();
    expect(sm.onUserTurn('Hello?')).toBeUndefined();
    expect(sm.currentNodeId).toBe('greeting');
    expect(sm.onUserTurn('Yes, speaking.')?.nodeId).toBe('verify');
  });

  it('accepts a verified identity even while still on the greeting node', () => {
    // The tool call can beat the user-turn transcript when the patient
    // confirms and states their DOB in quick succession.
    const sm = machine();
    const next = sm.onToolResult('verifyIdentity', { verified: true });
    expect(next?.nodeId).toBe(`item:${asthmaModule.instrument.items[0]!.linkId}`);
  });

  it('leaves verify only on a verified identity result', () => {
    const sm = machine();
    sm.onUserTurn();
    sm.onUserTurn();
    expect(sm.onToolResult('verifyIdentity', { verified: false, retry: true })).toBeUndefined();
    expect(sm.currentNodeId).toBe('verify');
    const next = sm.onToolResult('verifyIdentity', { verified: true });
    expect(next?.nodeId).toBe(`item:${asthmaModule.instrument.items[0]!.linkId}`);
    // The bridge owns the next utterance; the model only interprets its answer.
    expect(next?.spoken).toBe(asthmaModule.instrument.items[0]!.prompt);
    expect(next?.cue).toContain(asthmaModule.instrument.items[0]!.prompt);
    expect(next?.cue).toContain('Do NOT speak when this step begins');
    expect(next?.cue).toContain('ONLY action is chartLive');
  });

  it('does not advance verify on user turns — the tool decides', () => {
    const sm = machine();
    sm.onUserTurn();
    sm.onUserTurn();
    expect(sm.onUserTurn()).toBeUndefined();
    expect(sm.currentNodeId).toBe('verify');
  });

  it('advances an item on a successful chart and stays on a rejected one', () => {
    const sm = machine();
    sm.onUserTurn();
    sm.onToolResult('verifyIdentity', { verified: true });
    const [first, second] = asthmaModule.instrument.items;
    expect(sm.onToolResult('chartLive', undefined)).toBeUndefined();
    expect(sm.currentNodeId).toBe(`item:${first!.linkId}`);
    expect(sm.onToolResult('chartLive', { linkId: first!.linkId, value: 3 })?.nodeId).toBe(
      `item:${second!.linkId}`,
    );
  });

  it('puts the mandatory chart call in every charted-node transition cue', () => {
    const flow = buildIntakeFlow(asthmaModule);
    for (const node of flow.nodes) {
      if (node.kind === 'instrument-item') {
        expect(node.cue).toContain('ONLY action is chartLive');
        expect(node.cue).toContain('Never acknowledge or ask this question yourself');
      }
      if (node.kind === 'risk-question') {
        expect(node.cue).toContain('ONLY action is chartRiskAnswer');
        expect(node.cue).toContain('Never acknowledge or ask this question yourself');
      }
    }
  });

  it('re-anchors tool capture on a substantive answer but ignores instrument backchannels', () => {
    const sm = machine();
    sm.onUserTurn();
    sm.onToolResult('verifyIdentity', { verified: true });
    const first = asthmaModule.instrument.items[0]!;
    expect(sm.answerCaptureNudge('Yeah.')).toBeUndefined();
    expect(sm.answerCaptureNudge('I have been having trouble getting around lately.')).toContain(
      `chartLive for linkId "${first.linkId}"`,
    );
    expect(sm.answerCaptureNudge('A lot of the time.')).toContain(first.scaleHint);
    expect(sm.answerCaptureNudge('A lot of the time.')).toContain('patient need not say a number');
    expect(sm.answerCaptureNudge('Sometimes.')).toContain('Accept vague but meaningful natural language');

    for (const item of asthmaModule.instrument.items) {
      sm.onToolResult('chartLive', { linkId: item.linkId, value: 3 });
    }
    const risk = asthmaModule.riskQuestions[0];
    if (risk) {
      // "No" is a complete and important answer to a yes/no risk question.
      expect(sm.answerCaptureNudge('No.')).toContain(
        `chartRiskAnswer for linkId "${risk.linkId}"`,
      );
    }
  });

  it('rejects premature, stale and out-of-order chart calls', () => {
    const sm = machine();
    sm.onUserTurn();
    sm.onToolResult('verifyIdentity', { verified: true });
    const [first, second] = asthmaModule.instrument.items;

    expect(sm.chartCallRejection('chartLive', { linkId: first!.linkId, value: 3 }, false)).toContain(
      'premature',
    );
    expect(sm.chartCallRejection('chartLive', { linkId: second!.linkId, value: 3 }, true)).toContain(
      'stale-or-out-of-order',
    );
    expect(sm.chartCallRejection('chartLive', { linkId: first!.linkId, value: 3 }, true)).toBeUndefined();

    sm.onToolResult('chartLive', { linkId: first!.linkId, value: 3 });
    expect(sm.chartCallRejection('chartLive', { linkId: first!.linkId, value: 3 }, true)).toContain(
      'stale-or-out-of-order',
    );
  });

  it('re-syncs when the model charts an item out of order', () => {
    const sm = machine();
    sm.onUserTurn();
    sm.onToolResult('verifyIdentity', { verified: true });
    const last = asthmaModule.instrument.items.at(-1)!;
    const afterLast = sm.onToolResult('chartLive', { linkId: last.linkId, value: 2 });
    // Past the final item the flow moves to the first risk question (or concerns).
    const expected = asthmaModule.riskQuestions[0]
      ? `risk:${asthmaModule.riskQuestions[0].linkId}`
      : 'concerns';
    expect(afterLast?.nodeId).toBe(expected);
  });

  it('suppresses a re-chart of an item already behind us — no duplicate re-prompt', () => {
    const sm = machine();
    sm.onUserTurn();
    sm.onToolResult('verifyIdentity', { verified: true });
    const [first, second] = asthmaModule.instrument.items;
    sm.onToolResult('chartLive', { linkId: first!.linkId, value: 3 });
    expect(sm.currentNodeId).toBe(`item:${second!.linkId}`);
    // The model charts item 1 again (patient repeated themselves).
    expect(sm.onToolResult('chartLive', { linkId: first!.linkId, value: 3 })).toBeUndefined();
    expect(sm.currentNodeId).toBe(`item:${second!.linkId}`);
  });

  it('renders a nudge that is much smaller than the full prompt', () => {
    const sm = machine();
    const view = sm.view()!;
    expect(view.nudge.length).toBeLessThan(view.prompt.length / 2);
    expect(view.nudge).toContain('CURRENT STEP');
  });

  it('stays under Deepgram\'s 25k cumulative prompt cap across a full call', () => {
    // UpdatePrompt APPENDS: the running prompt is the Settings prompt plus
    // every nudge sent during the call. Managed LLMs truncate past 25,000
    // characters, and a truncated tail makes the agent freewheel — so the
    // worst-case walk (every node visited once) must fit with headroom.
    const flow = buildIntakeFlow(asthmaModule);
    const start = renderStateNode(asthmaModule, context, flow.start)!;
    const total = flow.nodes
      .filter((node) => node.id !== flow.start)
      .reduce(
        (sum, node) => sum + renderStateNode(asthmaModule, context, node.id)!.nudge.length,
        start.prompt.length,
      );
    expect(total).toBeLessThan(22_000);
  });

  it('never advances on Q&A tools', () => {
    const sm = machine();
    sm.onUserTurn();
    sm.onToolResult('verifyIdentity', { verified: true });
    expect(sm.onToolResult('getCareContext', { source: 'x' })).toBeUndefined();
    expect(sm.onToolResult('checkCoverage', { mock: true })).toBeUndefined();
    expect(sm.onToolResult('recordConcern', { concerns: 1 })).toBeUndefined();
  });

  it('walks risks → concerns → recap → close and terminates', () => {
    const sm = machine();
    sm.onUserTurn();
    sm.onToolResult('verifyIdentity', { verified: true });
    for (const item of asthmaModule.instrument.items) {
      sm.onToolResult('chartLive', { linkId: item.linkId, value: 3 });
    }
    for (const risk of asthmaModule.riskQuestions) {
      sm.onToolResult('chartRiskAnswer', { linkId: risk.linkId });
    }
    expect(sm.currentNodeId).toBe('concerns');
    sm.onUserTurn();
    expect(sm.onUserTurn()?.nodeId).toBe('recap');
    expect(sm.onUserTurn()?.nodeId).toBe('close');
    // Terminal: submission ends the call via the session, not the walker.
    expect(sm.onToolResult('submitQuestionnaire', undefined)).toBeUndefined();
    expect(sm.onUserTurn()).toBeUndefined();
    expect(sm.currentNodeId).toBe('close');
  });
});
