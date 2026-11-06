import type { ConditionModule } from '../conditions/types.js';
import type { PatientContext } from '../types.js';

/**
 * The call as data.
 *
 * Both orchestration modes render from this one spec, which is the point: the
 * flow is described once, so `prompt` mode and `state` mode cannot drift into
 * asking different questions. Changing the interview means changing the flow,
 * never one renderer.
 */

export type NodeKind =
  | 'greeting'
  | 'verify'
  | 'instrument-item'
  | 'risk-question'
  | 'open-concerns'
  | 'recap'
  | 'close';

export interface FlowNode {
  id: string;
  kind: NodeKind;
  /** Spoken instruction for this turn. May contain {{placeholders}}. */
  say: string;
  /** Exact bridge-owned speech for nodes where model-authored wording is unsafe. */
  spoken?: string;
  /** Tools the agent may call while on this node. */
  tools: string[];
  /** Next node id, or undefined for a terminal node. */
  next?: string;
  /** Node to visit for an off-script question, returning here afterwards. */
  detour?: string;
  /**
   * One-line imperative delivered inside the tool result that advanced onto
   * this node. UpdatePrompt lands one turn late — the model has usually begun
   * generating by the time the nudge arrives — so the cue rides the
   * FunctionCallResponse, which the model always reads before speaking.
   */
  cue?: string;
  meta?: Record<string, string | number>;
}

export interface Flow {
  moduleId: string;
  start: string;
  nodes: FlowNode[];
  /** Rules that outrank the flow entirely. */
  emergencyRules: string[];
}

const QA_TOOLS = ['getCareContext', 'checkCoverage', 'recordConcern'];

/**
 * Build the interview flow for a module.
 *
 * The Q&A tools are attached to every node rather than to a dedicated node
 * because patients ask questions whenever they want, not when the script
 * allows. A flow that only permits questions at the end would force the agent
 * to either ignore them or leave the flow.
 */
export function buildIntakeFlow(module: ConditionModule): Flow {
  const nodes: FlowNode[] = [];

  const itemIds = module.instrument.items.map((item) => `item:${item.linkId}`);
  const riskIds = module.riskQuestions.map((question) => `risk:${question.linkId}`);
  const afterItems = riskIds[0] ?? 'concerns';
  const afterRisks = 'concerns';

  nodes.push({
    id: 'greeting',
    kind: 'greeting',
    say: "Your opening line already (1) asked if this is {{firstName}}, (2) said who you are — Maya from their care team — and (3) explained the purpose: a quick pre-visit check-in to help their doctor prepare their care plan. Do NOT repeat any of that. Just respond to what they say: if they confirm they are {{firstName}} and are happy to continue, do NOT ask any health or symptom questions — go straight to asking them to tell you their date of birth so you can verify their identity. If it is a bad time, offer to call back and end warmly. If they say it is not {{firstName}} or a wrong number, apologize briefly and end without sharing any details.",
    tools: [],
    next: 'verify',
  });

  nodes.push({
    id: 'verify',
    kind: 'verify',
    say: 'Before any clinical questions, verify identity. Ask the patient for their date of birth — do not read it out to them, ask them to tell you. As soon as they say it, call verifyIdentity with the date converted to YYYY-MM-DD. Do NOT judge the match yourself — the tool decides. Follow exactly what its result tells you: if it matches, move on; if not, it will tell you to give one more try, and only after a second failure to end warmly with a clinic follow-up. Never announce a mismatch or end the call unless verifyIdentity told you to.',
    tools: ['verifyIdentity'],
    spoken: 'Can you tell me your full date of birth so I can verify your record?',
    next: itemIds[0] ?? 'concerns',
  });

  for (const [index, item] of module.instrument.items.entries()) {
    const isFirst = index === 0;
    const intro = isFirst
      ? 'Transition in one short sentence: you have a few quick questions about how the past four weeks have been. Then ask: '
      : 'Ask: ';
    const say =
      `${intro}"${item.prompt}" Keep this question's exact meaning and time frame — you may soften the wording, but NEVER substitute a different question of your own, and ask NOTHING else in this step: no lead-in questions, no extra questions, no "anything changed recently?". This exact question, once. ` +
      `Let them answer in their own words — do NOT mention numbers, scales, or ratings, and do NOT ask them to rate anything. ` +
      `You score the answer silently: on this item, ${item.scaleHint}. Map what they said to the closest number and call chartLive with linkId "${item.linkId}" and that number (${item.min}-${item.max}) — only for an answer to THIS question, never for small talk or an answer to something else. ` +
      `Do NOT repeat or read their answer back, do NOT say the number, and do NOT announce that you are noting or recording anything. React with ONE brief, warm acknowledgement that fits what they said ("that sounds rough", "glad to hear it") — vary it every time — then move on. ` +
      `Accept clinically meaningful vague answers such as "sometimes", "a lot", "not much", or "pretty often": silently choose the closest scale option and do not ask the question again. Only ask one short repair question when there was no usable answer at all (for example silence, "hello?", or a request to repeat). If they volunteer a number themselves, accept it without comment.`;
    nodes.push({
      id: `item:${item.linkId}`,
      kind: 'instrument-item',
      say,
      spoken: item.prompt,
      cue: `The bridge will ask exactly: "${item.prompt}" Do NOT speak when this step begins. Wait for the natural-language answer. Accept vague but meaningful phrases such as "sometimes", "a lot", "not much", or "pretty often" and silently choose the closest option using: ${item.scaleHint}. The patient need not say a number. Then your ONLY action is chartLive(linkId="${item.linkId}", value=your closest mapping); the tool response moves you forward. Never acknowledge or ask this question yourself.`,
      tools: ['chartLive', ...QA_TOOLS],
      next: itemIds[index + 1] ?? afterItems,
      meta: { linkId: item.linkId, min: item.min, max: item.max },
    });
  }

  for (const [index, question] of module.riskQuestions.entries()) {
    nodes.push({
      id: `risk:${question.linkId}`,
      kind: 'risk-question',
      say:
        `Ask gently: "${question.prompt}" Ask exactly this question — do not substitute your own version and do not add extra questions. ` +
        `Record the answer with chartRiskAnswer using linkId "${question.linkId}". Wait for their actual answer — NEVER chart a filler acknowledgement like "alright" or "okay". If the patient declines, accept that and move on.`,
      spoken: question.prompt,
      cue: `The bridge will ask exactly: "${question.prompt}" Do NOT speak when this step begins. Wait for the complete answer. Then your ONLY action is chartRiskAnswer(linkId="${question.linkId}", value=their answer); the tool response moves you forward. Never acknowledge or ask this question yourself.`,
      tools: ['chartRiskAnswer', ...QA_TOOLS],
      next: riskIds[index + 1] ?? afterRisks,
      meta: { linkId: question.linkId, expects: question.expects },
    });
  }

  nodes.push({
    id: 'concerns',
    kind: 'open-concerns',
    say: 'Ask what else has been on their mind about their {{conditionLower}}. Record each distinct thing with recordConcern. Answer clinical questions with getCareContext and cost or coverage questions with checkCoverage. When they have nothing more to raise, do not stop or wrap up — move straight into a warm recap of the one or two most important things they told you.',
    cue: 'The bridge will ask what else has been on their mind about their {{conditionLower}}. Do NOT speak when this step begins. Record each real concern with recordConcern, then wait.',
    spoken: 'Is there anything else on your mind about your {{conditionLower}} that you would like me to note for your clinician?',
    tools: QA_TOOLS,
    next: 'recap',
  });

  nodes.push({
    id: 'recap',
    kind: 'recap',
    say: 'Reflect back the one or two most important things they told you, in your own words, so they know they were heard. Offer one grounded, non-prescriptive tip from getCareContext if it fits. Say a clinician will review everything and be in touch. Then ask if there is anything they would like to ask before you finish, and WAIT — answer questions with getCareContext or checkCoverage. Do not state a score, a band, a medication, or a plan. Once they confirm they have no more questions, call submitQuestionnaire silently and say a warm goodbye.',
    cue: 'The bridge will tell the patient their answers will be reviewed and ask whether they have a question. Do NOT speak when this step begins. If they ask something, answer briefly with the appropriate tool. If they say they have no questions, wait for the bridge to move forward.',
    spoken: 'I have your answers and will make sure your clinician reviews them. Before we finish, is there anything you would like to ask me?',
    tools: QA_TOOLS,
    next: 'close',
  });

  nodes.push({
    id: 'close',
    kind: 'close',
    say: "You MUST actually invoke the submitQuestionnaire tool now, exactly once — saying you submitted without calling it loses the patient's answers. Call it SILENTLY: do not announce it or say \"one moment\". The instant it returns, thank them warmly and say goodbye.",
    cue: 'Now call submitQuestionnaire silently, then thank them warmly and say goodbye.',
    tools: ['submitQuestionnaire'],
  });

  return { moduleId: module.id, start: 'greeting', nodes, emergencyRules: module.emergencyRules };
}

// ------------------------------------------------------------ interpolation

/** Replaces {{key}} with the supplied value; unknown keys are left visible. */
export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}

export function flowValues(context: PatientContext, module: ConditionModule): Record<string, string> {
  return {
    firstName: context.fullName.split(' ')[0] ?? 'there',
    fullName: context.fullName,
    conditionDisplay: context.conditionDisplay ?? module.display,
    conditionLower: (context.conditionDisplay ?? module.display).toLowerCase(),
    birthDate: context.birthDate ?? 'unknown',
  };
}

export function nodeById(flow: Flow, id: string): FlowNode | undefined {
  return flow.nodes.find((node) => node.id === id);
}

/** Every tool any node may use — the union the live agent is given. */
export function allFlowTools(flow: Flow): string[] {
  return [...new Set(flow.nodes.flatMap((node) => node.tools))];
}
