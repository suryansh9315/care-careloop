import { describe, expect, it } from 'vitest';
import { asthmaModule } from '../conditions/asthma.js';
import { depressionModule } from '../conditions/depression.js';
import type { PatientContext } from '../types.js';
import { allFlowTools, buildIntakeFlow, interpolate, nodeById } from './flow.js';
import { compareRenderings, renderPromptMode, renderStateNode } from './renderers.js';

const context: PatientContext = {
  patientId: 'p1',
  fullName: 'Jane Doe',
  birthDate: '1985-03-14',
  moduleId: 'asthma',
  conditionDisplay: 'Asthma',
  currentMedications: [{ display: 'Albuterol inhaler' }],
  allergies: ['penicillin'],
  triggers: ['dust mite'],
  priorScores: [{ date: '2026-05-01', total: 17, band: 'Not well controlled' }],
  mock: true,
};

describe('buildIntakeFlow', () => {
  it('walks greeting → verify → every item → every risk → concerns → recap → close', () => {
    const flow = buildIntakeFlow(asthmaModule);
    const visited: string[] = [];
    let current = nodeById(flow, flow.start);

    while (current) {
      visited.push(current.id);
      if (visited.length > 100) throw new Error('flow does not terminate');
      current = current.next ? nodeById(flow, current.next) : undefined;
    }

    expect(visited[0]).toBe('greeting');
    expect(visited[1]).toBe('verify');
    expect(visited[visited.length - 1]).toBe('close');

    for (const item of asthmaModule.instrument.items) {
      expect(visited).toContain(`item:${item.linkId}`);
    }
    for (const question of asthmaModule.riskQuestions) {
      expect(visited).toContain(`risk:${question.linkId}`);
    }
    expect(visited).toContain('concerns');
    expect(visited).toContain('recap');
  });

  it('reaches close for every module, so no flow can strand a patient', () => {
    for (const module of [asthmaModule, depressionModule]) {
      const flow = buildIntakeFlow(module);
      const seen = new Set<string>();
      let current = nodeById(flow, flow.start);
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        current = current.next ? nodeById(flow, current.next) : undefined;
      }
      expect(seen.has('close'), module.id).toBe(true);
    }
  });

  it('asks each instrument item exactly once', () => {
    const flow = buildIntakeFlow(depressionModule);
    const itemNodes = flow.nodes.filter((n) => n.kind === 'instrument-item');
    expect(itemNodes).toHaveLength(depressionModule.instrument.items.length);
    expect(new Set(itemNodes.map((n) => n.id)).size).toBe(itemNodes.length);
  });

  it('only lets close submit the questionnaire', () => {
    const flow = buildIntakeFlow(asthmaModule);
    const submitters = flow.nodes.filter((n) => n.tools.includes('submitQuestionnaire'));
    expect(submitters.map((n) => n.id)).toEqual(['close']);
  });

  it('allows questions at every clinical step, not just at the end', () => {
    const flow = buildIntakeFlow(asthmaModule);
    for (const node of flow.nodes.filter((n) => n.kind === 'instrument-item')) {
      expect(node.tools, node.id).toContain('getCareContext');
      expect(node.tools, node.id).toContain('checkCoverage');
    }
  });

  it('carries the module emergency rules', () => {
    expect(buildIntakeFlow(depressionModule).emergencyRules).toEqual(
      depressionModule.emergencyRules,
    );
  });
});

describe('interpolate', () => {
  it('substitutes known keys and leaves unknown ones visible', () => {
    expect(interpolate('Hi {{firstName}}', { firstName: 'Jane' })).toBe('Hi Jane');
    expect(interpolate('Hi {{nope}}', {})).toBe('Hi {{nope}}');
  });
});

describe('renderings', () => {
  it('prompt mode contains every question and every emergency rule', () => {
    const prompt = renderPromptMode(asthmaModule, context);
    for (const item of asthmaModule.instrument.items) {
      expect(prompt).toContain(item.prompt);
    }
    for (const rule of asthmaModule.emergencyRules) {
      expect(prompt).toContain(rule);
    }
  });

  it('puts the emergency rules before the flow in prompt mode', () => {
    const prompt = renderPromptMode(depressionModule, context);
    const firstRule = prompt.indexOf(depressionModule.emergencyRules[0] as string);
    const flowHeading = prompt.indexOf('# CALL FLOW');
    expect(firstRule).toBeGreaterThan(-1);
    expect(firstRule).toBeLessThan(flowHeading);
  });

  it('never leaks an uninterpolated placeholder to the agent', () => {
    expect(renderPromptMode(asthmaModule, context)).not.toMatch(/\{\{\w+\}\}/);
    const node = renderStateNode(asthmaModule, context, 'greeting');
    expect(node?.prompt).not.toMatch(/\{\{\w+\}\}/);
  });

  it('gates tools per node in state mode', () => {
    const greeting = renderStateNode(asthmaModule, context, 'greeting');
    const firstItem = renderStateNode(asthmaModule, context, 'item:act-1');
    expect(greeting?.tools).toEqual([]);
    expect(firstItem?.tools).toContain('chartLive');
    expect(firstItem?.tools).not.toContain('submitQuestionnaire');
  });

  it('gives prompt mode strictly more tools at once than any single state node', () => {
    const metrics = compareRenderings(asthmaModule, context);
    expect(metrics.promptTools).toBeGreaterThanOrEqual(metrics.maxNodeTools);
    expect(metrics.promptChars).toBeGreaterThan(0);
  });

  it('returns undefined for a node that does not exist', () => {
    expect(renderStateNode(asthmaModule, context, 'no-such-node')).toBeUndefined();
  });

  it('exposes the union of node tools', () => {
    const tools = allFlowTools(buildIntakeFlow(asthmaModule));
    expect(tools).toContain('chartLive');
    expect(tools).toContain('chartRiskAnswer');
    expect(tools).toContain('submitQuestionnaire');
  });
});
