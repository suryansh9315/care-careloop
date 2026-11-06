import type { ConditionModule } from '../conditions/types.js';
import type { PatientContext } from '../types.js';
import { allFlowTools, buildIntakeFlow, flowValues, interpolate, nodeById, type Flow } from './flow.js';

/**
 * Two renderings of the same flow.
 *
 * `prompt` mode flattens the whole flow into one system prompt; the agent
 * self-navigates.
 *
 * `state` mode renders one node at a time; the bridge walks the flow (see
 * statemachine.ts) and replaces the live prompt at each step via Deepgram's
 * UpdatePrompt. The function list cannot change mid-call, so a node's `tools`
 * gate what the prompt *instructs*, not what is declared to the model.
 * Keeping both renderers honest against one spec is what makes the comparison
 * meaningful in the simulator.
 */

export type OrchestrationMode = 'prompt' | 'state';

function historyLine(context: PatientContext): string {
  if (context.priorScores.length === 0) {
    return 'This is the first recorded check-in for this patient. Do not imply you have spoken before.';
  }
  const recent = context.priorScores.slice(-3);
  const last = recent[recent.length - 1];
  return (
    `Previous totals, oldest to newest: ${recent.map((s) => `${s.total} (${s.date.slice(0, 10)})`).join(', ')}. ` +
    `Last time the score was ${last?.total} — "${last?.band}". You may weave this in naturally when acknowledging their answers, ` +
    'but NEVER turn it into a question of your own ("how have you been since last time?") — the scripted questions cover that. ' +
    'Do not ask the patient to repeat anything already listed here.'
  );
}

function preamble(module: ConditionModule, context: PatientContext, flow: Flow): string {
  return `You are Maya, a warm, unhurried check-in assistant calling on behalf of a clinic before a patient's appointment. You are on the phone: keep every turn to one or two sentences and never read out lists.

# ABSOLUTE RULES — these override everything below
${flow.emergencyRules.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}
${flow.emergencyRules.length + 1}. You are NOT a prescriber and NOT a diagnostician. Never say what medication the patient will get, never give a dose, and never state or confirm a diagnosis. Say a clinician reviews everything and decides.
${flow.emergencyRules.length + 2}. Never invent clinical facts. Use getCareContext, or say a clinician will answer it.
${flow.emergencyRules.length + 3}. If the patient wants to stop, stop immediately and warmly.

# WHO YOU ARE CALLING
Name: ${context.fullName}
Condition on file: ${context.conditionDisplay ?? module.display}
${context.birthDate ? `Date of birth on file: ${context.birthDate}` : 'No date of birth on file.'}
Current medications: ${context.currentMedications.map((m) => m.display).join('; ') || 'none recorded'}
Recorded allergies: ${context.allergies.join('; ') || 'none recorded'}
Known triggers: ${context.triggers.join('; ') || 'none recorded'}
History: ${historyLine(context)}`;
}

const STYLE = `# STYLE
Speak like a person, not a form. Contractions are good. Keep every turn to one or two short sentences. Ask ONE question at a time, then wait for the answer — never stack questions or ask one the current step does not contain. Vary how you acknowledge answers and don't say "thank you" after every single one — sometimes just move straight on, sometimes give one brief genuine reaction ("that sounds really tough", "glad to hear that"). Never repeat or read the patient's answer back to them. Never mention numbers, scales, ratings, or "1 to 5" to the patient — they answer in their own words and you translate silently. Never say "linkId", "tool", "system", "score" or "band" out loud. Never speak stage directions or internal notes such as "waiting", "duplicate message", or "end of conversation". If there is silence, stay silent.`;

/** Whole flow as one prompt. */
export function renderPromptMode(module: ConditionModule, context: PatientContext): string {
  const flow = buildIntakeFlow(module);
  const values = flowValues(context, module);

  const steps = flow.nodes
    .map((node, index) => {
      const tools = node.tools.length ? `  [tools: ${node.tools.join(', ')}]` : '';
      return `${index + 1}. (${node.kind}) ${interpolate(node.say, values)}${tools}`;
    })
    .join('\n');

  return `${preamble(module, context, flow)}

# CALL FLOW — follow these steps IN ORDER, one at a time
Do not skip or reorder steps. Ask a single question, wait for the answer, then move on.
${steps}

If at any point the patient asks a question or raises a worry, handle it briefly — getCareContext for clinical or educational questions, checkCoverage for insurance or cost, recordConcern to note a worry — then RESUME the step you were on.

${STYLE}`;
}

export interface StateModeView {
  nodeId: string;
  prompt: string;
  /**
   * Compact per-node prompt for mid-call UpdatePrompt. Deepgram's documented
   * semantics: UpdatePrompt ADDS to the running prompt (never replaces), with
   * a 25,000-character cap on managed LLMs — exceeding it truncates the tail,
   * which is what makes the agent freewheel. So each nudge must be small
   * enough that a dozen of them stay under budget, must explicitly supersede
   * the CURRENT STEP blocks accumulating above it, and re-anchors the core
   * discipline rules at the tail, where the model's attention is strongest.
   */
  nudge: string;
  /**
   * One-line imperative appended to the tool result that advanced onto this
   * node. The nudge arrives one turn late (the model has usually started
   * generating); the cue rides the FunctionCallResponse, which the model
   * always reads before speaking — so the very next utterance is on-script.
   */
  cue?: string;
  /** Exact speech injected by the bridge; the model must not author this turn. */
  spoken?: string;
  tools: string[];
  next?: string;
}

/** One node's prompt plus the tools gated to it. */
export function renderStateNode(
  module: ConditionModule,
  context: PatientContext,
  nodeId: string,
): StateModeView | undefined {
  const flow = buildIntakeFlow(module);
  const node = nodeById(flow, nodeId);
  if (!node) return undefined;
  const values = flowValues(context, module);

  // The Q&A tools ride along on most nodes, but in state mode the current
  // step is all the model reliably attends to — without this line it refuses
  // questions it has the tools to answer (seen live: "I can't help with
  // insurance questions" while checkCoverage sat in its function list).
  const qaGuides: Record<string, string> = {
    getCareContext: 'getCareContext for clinical or educational questions',
    checkCoverage: 'checkCoverage for insurance, cost, or coverage questions',
    recordConcern: 'recordConcern to write down a worry for the clinician',
  };
  const qaTools = node.tools.filter((tool) => qaGuides[tool]);
  const qaLine = qaTools.length
    ? `\n\nIf the patient asks a question or raises a worry at any point, handle it before continuing: ${qaTools
        .map((tool) => qaGuides[tool])
        .join('; ')}. Answer briefly from the tool result, then return to this step.`
    : '';

  const instruction = node.spoken && node.cue ? node.cue : node.say;
  const step = `# CURRENT STEP (${node.kind}) — this REPLACES every earlier CURRENT STEP
${interpolate(instruction, values)}${qaLine}

When this step is done, stop and wait. Do not continue to the next question on your own.${
    node.next
      ? ' More steps follow — do NOT wrap up, summarise, or end the call; the system moves you forward.'
      : ''
  }`;

  // Re-anchored on every nudge (UpdatePrompt appends, so this lands at the
  // tail of the running prompt each time — the hackathon's global-block trick).
  const reanchor = `Reminder: one or two short sentences per turn, ONE question at a time, only the question this step contains — never invent your own. Never mention numbers, scales, ratings, tools, or scores. All rules from the start of the call still apply.`;

  return {
    nodeId: node.id,
    prompt: `${preamble(module, context, flow)}

${step}

${STYLE}`,
    nudge: `${step}

${reanchor}`,
    cue: node.cue ? interpolate(node.cue, values) : undefined,
    spoken: node.spoken ? interpolate(node.spoken, values) : undefined,
    tools: node.tools,
    next: node.next,
  };
}

/** Metrics used to compare the two renderings deterministically. */
export function compareRenderings(
  module: ConditionModule,
  context: PatientContext,
): {
  promptChars: number;
  promptTools: number;
  stateStartNode: string;
  stateNodes: number;
  stateStartTools: number;
  maxNodeTools: number;
} {
  const flow = buildIntakeFlow(module);
  const prompt = renderPromptMode(module, context);
  const start = renderStateNode(module, context, flow.start);

  return {
    promptChars: prompt.length,
    promptTools: allFlowTools(flow).length,
    stateStartNode: flow.start,
    stateNodes: flow.nodes.length,
    stateStartTools: start?.tools.length ?? 0,
    maxNodeTools: Math.max(...flow.nodes.map((node) => node.tools.length)),
  };
}
