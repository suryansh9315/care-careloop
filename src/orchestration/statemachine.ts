import type { ConditionModule } from '../conditions/types.js';
import type { PatientContext } from '../types.js';
import { buildIntakeFlow, nodeById, type Flow, type FlowNode, type NodeKind } from './flow.js';
import { renderStateNode, type StateModeView } from './renderers.js';

/**
 * ORCH_MODE=state: walk the flow node by node.
 *
 * The bridge — not the model — decides when the interview moves forward. Two
 * kinds of signal advance the walk:
 *
 * 1. Tool results. These are authoritative: a charted answer moves past that
 *    item, a verified DOB moves past verification. The Q&A tools
 *    (getCareContext, checkCoverage, recordConcern) never advance — a patient
 *    question is a detour, not progress.
 * 2. User turns, only on conversational nodes that have no charting tool
 *    (greeting, open-concerns, recap). This is a heuristic: the thresholds
 *    below match the number of exchanges the node's script expects.
 *
 * Deepgram cannot change the function list mid-call, so state mode still
 * declares every tool at Settings time; what changes per node is the prompt,
 * sent via UpdatePrompt. Gating is therefore instruction-level, same as prompt
 * mode — the win of state mode is that the *current step* is always explicit,
 * so the model cannot skip or reorder questions.
 */

/** Conversational nodes advance after this many patient turns. */
const USER_TURNS_TO_ADVANCE: Partial<Record<NodeKind, number>> = {
  // The hardcoded opener already covers identity, who is calling and why, so
  // the first patient reply ("yes / sure") is the confirmation → move to
  // verification immediately.
  greeting: 1,
  // Turn 1: the concern itself (charted via recordConcern, which does not
  // advance). Turn 2: "no, nothing else" → move to recap.
  'open-concerns': 2,
  // One acknowledgement of the recap → move to close.
  recap: 1,
};

/** Existing no-more matcher plus the "No. Thank you." used in the live call. */
export function isNoMoreResponse(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return /^(no(pe)?( that s all)?|no thank you|nothing( else)?|not really|that s all|thats all)$/.test(normalized);
}

export class FlowStateMachine {
  private readonly flow: Flow;
  private currentId: string;
  private userTurnsOnNode = 0;

  constructor(
    private readonly module: ConditionModule,
    private readonly context: PatientContext,
  ) {
    this.flow = buildIntakeFlow(module);
    this.currentId = this.flow.start;
  }

  get currentNodeId(): string {
    return this.currentId;
  }

  get currentNode(): FlowNode | undefined {
    return nodeById(this.flow, this.currentId);
  }

  view(): StateModeView | undefined {
    return renderStateNode(this.module, this.context, this.currentId);
  }

  /**
   * A just-in-time instruction for the answer turn. The transition cue is
   * delivered before the question, but live models can lose that requirement
   * after listening for several seconds. Re-anchor it when a substantive
   * answer arrives, before the model chooses speech instead of a function.
   */
  answerCaptureNudge(text: string): string | undefined {
    const node = this.currentNode;
    const linkId = node?.meta?.linkId;
    if (!node || !linkId) return undefined;
    const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normalized) return undefined;
    if (node.kind === 'instrument-item') {
      // Deepgram can emit a brief backchannel as its own ConversationText
      // before the substantive answer. Do not make "yeah" the ACT response.
      if (/^(yes|yeah|yep|okay|ok|alright|right|mhm|uh huh)$/.test(normalized)) return undefined;
      const item = this.module.instrument.items.find((candidate) => candidate.linkId === linkId);
      return `ANSWER HEARD. Accept vague but meaningful natural language such as "sometimes", "a lot", "not much", or "pretty often". The patient need not say a number. Silently map the latest answer using: ${item?.scaleHint ?? `${node.meta?.min}-${node.meta?.max}`}. Before speaking, call chartLive for linkId "${linkId}" with your closest mapping. Never acknowledge or repeat the question.`;
    }
    if (node.kind === 'risk-question') {
      return `ANSWER HEARD. Before speaking, call chartRiskAnswer for linkId "${linkId}" using the complete latest answer. Never acknowledge or repeat the question.`;
    }
    return undefined;
  }

  /**
   * The voice model may hallucinate a chart call before asking the question,
   * or retry a stale call after the walker has advanced. Tool arguments are
   * therefore never sufficient authority to mutate clinical state.
   */
  chartCallRejection(
    name: string,
    args: Record<string, unknown>,
    answerObserved: boolean,
  ): string | undefined {
    if (name !== 'chartLive' && name !== 'chartRiskAnswer') return undefined;
    const node = this.currentNode;
    const expectedName = node?.kind === 'instrument-item'
      ? 'chartLive'
      : node?.kind === 'risk-question'
        ? 'chartRiskAnswer'
        : undefined;
    const expectedLinkId = String(node?.meta?.linkId ?? '');
    const actualLinkId = String(args.linkId ?? '');
    if (!expectedName || name !== expectedName || !expectedLinkId || actualLinkId !== expectedLinkId) {
      return `stale-or-out-of-order: expected ${expectedName ?? 'no chart tool'} for ${expectedLinkId || this.currentNodeId}`;
    }
    if (!answerObserved) return `premature: no patient answer observed for ${expectedLinkId}`;
    return undefined;
  }

  /**
   * Feed a dispatched tool result. Returns the next node's view when the flow
   * advanced, undefined when it stays put (failed chart, retry, Q&A tool).
   */
  onToolResult(name: string, detail?: Record<string, unknown>): StateModeView | undefined {
    switch (name) {
      case 'verifyIdentity': {
        if (detail?.verified !== true) return undefined;
        const kind = this.currentNode?.kind;
        // A quick patient can state their DOB while the walk is still on the
        // greeting node (the tool call can beat the user-turn transcript);
        // a verified identity moves past verification from either node.
        if (kind !== 'verify' && kind !== 'greeting') return undefined;
        if (kind === 'greeting') this.currentId = 'verify';
        return this.advance();
      }
      case 'chartLive':
        return this.advancePast('item', detail);
      case 'chartRiskAnswer':
        return this.advancePast('risk', detail);
      default:
        // Q&A tools and submitQuestionnaire never move the flow; submission
        // ends the call via the session's hangup timer instead.
        return undefined;
    }
  }

  /** Feed one patient turn. Advances only conversational nodes. */
  onUserTurn(text?: string): StateModeView | undefined {
    const node = this.currentNode;
    const normalized = text?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (node?.kind === 'greeting' && text !== undefined) {
      return /^(yes|yeah|yep|speaking|this is|yes speaking|sure|go ahead)(\b|$)/.test(normalized ?? '')
        ? this.advance()
        : undefined;
    }
    if (node?.kind === 'open-concerns' && text !== undefined) {
      return isNoMoreResponse(text)
        ? this.advance()
        : undefined;
    }
    if (node?.kind === 'recap' && text !== undefined) {
      return isNoMoreResponse(text)
        ? this.advance()
        : undefined;
    }
    const threshold = node ? USER_TURNS_TO_ADVANCE[node.kind] : undefined;
    if (!threshold) return undefined;
    this.userTurnsOnNode += 1;
    return this.userTurnsOnNode >= threshold ? this.advance() : undefined;
  }

  /**
   * A successful chart names the item it recorded. Re-sync to that item before
   * stepping, so a model that answered out of order pulls the walk back onto
   * the spec instead of drifting one node ahead of reality.
   */
  private advancePast(prefix: 'item' | 'risk', detail?: Record<string, unknown>): StateModeView | undefined {
    if (!detail?.linkId) return undefined; // rejected chart — stay on the node
    const before = this.currentId;
    const charted = nodeById(this.flow, `${prefix}:${String(detail.linkId)}`);
    if (charted) this.currentId = charted.id;
    const view = this.advance();
    // A re-chart of an item already behind us lands where we already are.
    // Re-sending the same prompt just burns Deepgram's prompt budget.
    return this.currentId === before ? undefined : view;
  }

  private advance(): StateModeView | undefined {
    const node = this.currentNode;
    if (!node?.next) return undefined; // terminal
    this.currentId = node.next;
    this.userTurnsOnNode = 0;
    return this.view();
  }
}
