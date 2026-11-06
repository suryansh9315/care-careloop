import type { Communication, Observation, QuestionnaireResponse } from '@medplum/fhirtypes';
import { getModule } from '../conditions/registry.js';
import type { AgentFunctionDeclaration } from '../integrations/deepgram.js';
import { bestEffortCreate } from '../integrations/medplum.js';
import { getMossClient } from '../integrations/moss.js';
import { checkEligibility, spokenCoverageSummary } from '../integrations/stedi.js';
import { logger } from '../logger.js';
import type { CallOutcome, Concern, InstrumentAnswer, PatientContext, RiskAnswer } from '../types.js';

/**
 * The complete set of actions the voice model may trigger.
 *
 * The model receives no credentials and reaches no external system directly.
 * It emits a function call; the bridge decides what actually runs, validates
 * the arguments, and returns a short grounded result. Anything not declared
 * here is simply not possible from inside the conversation.
 */

export const AGENT_FUNCTIONS: AgentFunctionDeclaration[] = [
  {
    name: 'verifyIdentity',
    description:
      'Check the date of birth the patient just gave against the record. Call this as soon as they state their date of birth, BEFORE any clinical questions. Convert what they said to a date and pass it. The tool — not you — decides whether it matches; do exactly what its result tells you.',
    parameters: {
      type: 'object',
      properties: {
        dateOfBirth: {
          type: 'string',
          description:
            'The date of birth the patient stated, as YYYY-MM-DD (e.g. "1979-05-14"). Convert spoken forms like "May fourteenth nineteen seventy-nine" to this format.',
        },
      },
      required: ['dateOfBirth'],
    },
  },
  {
    name: 'chartLive',
    description:
      'Record one questionnaire answer immediately after the patient finishes answering. The patient normally answers in natural language, not with a number: infer the closest scale value yourself and call this function. This must be your first and only action after a usable answer; do not acknowledge, speak, or repeat the question first. Call once per item.',
    parameters: {
      type: 'object',
      properties: {
        linkId: { type: 'string', description: 'The item id, e.g. "act-1" or "phq9-3".' },
        value: {
          type: 'integer',
          description:
            'The scale value YOU infer from the patient’s natural-language answer. The patient does not need to say a number. Map phrases such as “a lot,” “every day,” or “not at all” to the closest value using the current item’s scale.',
        },
      },
      required: ['linkId', 'value'],
    },
  },
  {
    name: 'chartRiskAnswer',
    description:
      'Record an answer to one supplemental future-risk question. This function call must be your first and only action after the patient finishes answering: do not acknowledge, speak, or repeat the question before calling it. These answers are not part of the questionnaire total.',
    parameters: {
      type: 'object',
      properties: {
        linkId: { type: 'string', description: 'The risk question id, e.g. "risk-exacerbations".' },
        value: { type: 'string', description: 'The patient answer in their own words.' },
      },
      required: ['linkId', 'value'],
    },
  },
  {
    name: 'recordConcern',
    description:
      'Record something the patient raised that is not covered by the questionnaire — a worry, a symptom, a question about their life with the condition.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The concern in the patient’s own words.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'getCareContext',
    description:
      'Look up clinical or educational information about the condition to answer a patient question — inhaler technique, what a medication does, warning signs, self-help. Use ONLY for clinical or educational questions. Never use it for insurance, cost or coverage.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The patient’s question.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'checkCoverage',
    description:
      'Answer a question about insurance, plan, cost, copay or prior authorisation. Use this instead of guessing. Never promise that something is covered.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The patient’s coverage question.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'submitQuestionnaire',
    description:
      'Submit the completed questionnaire. Call this exactly once, after the recap and before saying goodbye.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

/** Mutable per-call state owned by the bridge, never by the model. */
export interface CallState {
  callId: string;
  context: PatientContext;
  answers: Map<string, number>;
  riskAnswers: Map<string, string>;
  concerns: Concern[];
  submitted: boolean;
  questionnaireResponse?: QuestionnaireResponse;
  startedAt: string;
  /** Identity check: how many times a DOB has been offered, and whether it matched. */
  dobAttempts: number;
  dobVerified: boolean;
  /** Idempotency: Deepgram can retry a function call. */
  handledCallIds: Set<string>;
}

export function createCallState(callId: string, context: PatientContext): CallState {
  return {
    callId,
    context,
    answers: new Map(),
    riskAnswers: new Map(),
    concerns: [],
    submitted: false,
    startedAt: new Date().toISOString(),
    dobAttempts: 0,
    dobVerified: false,
    handledCallIds: new Set(),
  };
}

export interface ToolResult {
  /** Short text handed back to the model to speak from. */
  say: string;
  /** Structured detail for logs and tests. */
  detail?: Record<string, unknown>;
}

async function chartLive(state: CallState, args: Record<string, unknown>): Promise<ToolResult> {
  const module = getModule(state.context.moduleId);
  const linkId = String(args.linkId ?? '');
  const item = module.instrument.items.find((i) => i.linkId === linkId);
  if (!item) {
    return { say: `That item id is not part of this questionnaire. Ask the next question in order.` };
  }

  const raw = Number(args.value);
  if (!Number.isFinite(raw)) {
    return { say: "That answer was not a number. Map the patient's words to the closest number on the item's scale yourself and call chartLive again — do not ask the patient for a number." };
  }
  const value = Math.min(Math.max(Math.round(raw), item.min), item.max);
  state.answers.set(linkId, value);

  // Best-effort: chart latency must never make the agent stall mid-call.
  await bestEffortCreate<Observation>(
    {
      resourceType: 'Observation',
      status: 'preliminary',
      subject: { reference: `Patient/${state.context.patientId}` },
      effectiveDateTime: new Date().toISOString(),
      code: { coding: [{ system: 'http://loinc.org', code: item.loincCode, display: item.prompt }] },
      valueInteger: value,
    },
    { callId: state.callId, linkId },
  );

  await bestEffortCreate<Communication>(
    {
      resourceType: 'Communication',
      status: 'in-progress',
      subject: { reference: `Patient/${state.context.patientId}` },
      category: [{ text: 'careloop-chart' }],
      sent: new Date().toISOString(),
      payload: [{ contentString: `${item.prompt} → ${value}` }],
    },
    { callId: state.callId },
  );

  const remaining = module.instrument.items.filter((i) => !state.answers.has(i.linkId));
  return {
    // Never imply the call is winding down: "that was the last item" made the
    // agent announce completion mid-call while risk questions still remained.
    say:
      remaining.length > 0
        ? `Recorded. ${remaining.length} question${remaining.length === 1 ? '' : 's'} left.`
        : 'Recorded. The rating questions are done, but the check-in is NOT over — continue with the next step.',
    detail: { linkId, value, remaining: remaining.length },
  };
}

async function chartRiskAnswer(state: CallState, args: Record<string, unknown>): Promise<ToolResult> {
  const module = getModule(state.context.moduleId);
  const linkId = String(args.linkId ?? '');
  if (!module.riskQuestions.some((q) => q.linkId === linkId)) {
    return { say: 'That is not one of the risk questions. Continue with the flow.' };
  }
  const value = String(args.value ?? '').slice(0, 500);
  state.riskAnswers.set(linkId, value);
  return { say: 'Recorded.', detail: { linkId } };
}

async function recordConcern(state: CallState, args: Record<string, unknown>): Promise<ToolResult> {
  const text = String(args.text ?? '').trim().slice(0, 1000);
  if (!text) return { say: 'Nothing to record.' };

  state.concerns.push({ text, recordedAt: new Date().toISOString() });
  await bestEffortCreate<Communication>(
    {
      resourceType: 'Communication',
      status: 'in-progress',
      subject: { reference: `Patient/${state.context.patientId}` },
      category: [{ text: 'careloop-concern' }],
      sent: new Date().toISOString(),
      payload: [{ contentString: `Patient concern: ${text}` }],
    },
    { callId: state.callId },
  );

  return {
    say: 'Noted — I have written that down for the clinician.',
    detail: { concerns: state.concerns.length },
  };
}

async function getCareContext(state: CallState, args: Record<string, unknown>): Promise<ToolResult> {
  const module = getModule(state.context.moduleId);
  const question = String(args.question ?? '').slice(0, 500);

  const snippets = await getMossClient(module.moss).retrieve(question, { k: 1 });
  const top = snippets[0];
  if (!top) {
    return {
      say: 'I do not have clinic guidance on that one. I will note it down so your clinician can answer it.',
    };
  }

  await bestEffortCreate<Communication>(
    {
      resourceType: 'Communication',
      status: 'in-progress',
      subject: { reference: `Patient/${state.context.patientId}` },
      category: [{ text: 'careloop-education' }],
      sent: new Date().toISOString(),
      payload: [{ contentString: `Patient asked: ${question} → answered from ${top.source}` }],
    },
    { callId: state.callId },
  );

  return {
    say: `${top.text}\n\n(Relay this concisely in your own words. Do not add a diagnosis or a dose. Source: ${top.source}.)`,
    detail: { source: top.source, mock: top.mock },
  };
}

async function checkCoverage(state: CallState, args: Record<string, unknown>): Promise<ToolResult> {
  const module = getModule(state.context.moduleId);
  const question = String(args.question ?? '').slice(0, 500);

  // The likely step-up product is used for the prior-auth heuristic. The plan
  // itself is not selected here — that happens after the call.
  const likelyMedication = Object.values(module.steps)
    .flatMap((step) => step.medications)
    .find((med) => med.role === 'controller' || med.role === 'primary');

  const result = await checkEligibility(state.context.coverage, likelyMedication);

  await bestEffortCreate<Communication>(
    {
      resourceType: 'Communication',
      status: 'in-progress',
      subject: { reference: `Patient/${state.context.patientId}` },
      category: [{ text: 'careloop-coverage' }],
      sent: new Date().toISOString(),
      payload: [
        {
          contentString: `Coverage question: ${question} → covered=${result.covered}, priorAuth=${result.priorAuthRequired}${
            result.mock ? ' (mock)' : ''
          }`,
        },
      ],
    },
    { callId: state.callId },
  );

  return { say: spokenCoverageSummary(result), detail: { mock: result.mock } };
}

async function submitQuestionnaire(state: CallState): Promise<ToolResult> {
  if (state.submitted) {
    return { say: 'Already submitted. Close the call warmly.' };
  }
  const module = getModule(state.context.moduleId);

  const response: QuestionnaireResponse = {
    resourceType: 'QuestionnaireResponse',
    status: 'completed',
    subject: { reference: `Patient/${state.context.patientId}` },
    authored: new Date().toISOString(),
    item: [
      ...module.instrument.items
        .filter((item) => state.answers.has(item.linkId))
        .map((item) => ({
          linkId: item.linkId,
          text: item.prompt,
          answer: [{ valueInteger: state.answers.get(item.linkId) as number }],
        })),
      ...module.riskQuestions
        .filter((q) => state.riskAnswers.has(q.linkId))
        .map((q) => ({
          linkId: q.linkId,
          text: q.prompt,
          answer: [{ valueString: state.riskAnswers.get(q.linkId) as string }],
        })),
      ...state.concerns.map((concern, index) => ({
        linkId: `concern-${index + 1}`,
        text: 'Patient concern',
        answer: [{ valueString: concern.text }],
      })),
    ],
  };

  const created = await bestEffortCreate(response, { callId: state.callId });
  state.questionnaireResponse = created ?? response;
  state.submitted = true;

  logger.info(
    { callId: state.callId, answers: state.answers.size, concerns: state.concerns.length },
    'tools.questionnaire.submitted',
  );

  return { say: 'Submitted. Give the closing recap and say goodbye.' };
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Parse a date of birth spoken or written in almost any form into y/m/d.
 *
 * The agent is asked for ISO, but people (and speech-to-text) produce
 * "May 14 1979", "14/05/1979", "5-14-79" and worse. Being liberal here is the
 * whole point: a correct birth date must never be rejected because of format.
 * Returns undefined only when no plausible date can be recovered.
 */
export function parseDob(input: string): { y: number; m: number; d: number } | undefined {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) return undefined;

  const iso = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return { y: +iso[1]!, m: +iso[2]!, d: +iso[3]! };

  const year = s.match(/\b(18|19|20)\d{2}\b/);
  const monthName = MONTHS.findIndex((m) => s.includes(m));
  if (year && monthName >= 0) {
    const rest = s.replace(year[0], ' ');
    const day = rest.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (day) return { y: +year[0], m: monthName + 1, d: +day[1]! };
  }

  // Numeric separators. A four-digit group fixes the year; otherwise assume the
  // US month/day/year order the agent is prompted to send.
  const parts = s.match(/\b(\d{1,4})\b/g);
  if (parts && parts.length >= 3) {
    const yi = parts.findIndex((p) => p.length === 4);
    if (yi >= 0) {
      const y = +parts[yi]!;
      const [m, d] = parts.filter((_, i) => i !== yi).map(Number);
      if (m && d) return { y, m: m > 12 && d <= 12 ? d : m, d: m > 12 && d <= 12 ? m : d };
    }
  }
  return undefined;
}

const sameDate = (
  a: { y: number; m: number; d: number },
  b: { y: number; m: number; d: number },
): boolean => a.y === b.y && a.m === b.m && a.d === b.d;

async function verifyIdentity(state: CallState, args: Record<string, unknown>): Promise<ToolResult> {
  const onFile = state.context.birthDate;
  // Nothing to check against — do not strand the patient on a record gap.
  if (!onFile) {
    state.dobVerified = true;
    logger.warn({ callId: state.callId }, 'verify.no-dob-on-file');
    return { say: 'No date of birth is on file, so identity cannot be checked here. Continue with the check-in.' };
  }

  state.dobAttempts += 1;
  const spoken = String(args.dateOfBirth ?? '');
  const given = parseDob(spoken);
  const expected = parseDob(onFile);
  const matched = Boolean(given && expected && sameDate(given, expected));

  logger.info(
    { callId: state.callId, attempt: state.dobAttempts, matched, mock: !state.context.birthDate },
    'verify.dob',
  );

  if (matched) {
    state.dobVerified = true;
    return {
      // "Move on to the first question" invited the model to invent one while
      // the next node's prompt was still in flight — the cue appended to this
      // result names the actual question, so say only what is safe now.
      say: 'That matches our records. Thank them briefly, then continue exactly as instructed next.',
      detail: { verified: true, attempts: state.dobAttempts },
    };
  }

  if (state.dobAttempts < 2) {
    return {
      say: "That did not match. Ask them, warmly, to say their full date of birth once more — month, day and year. This is their second and final try.",
      detail: { verified: false, attempts: state.dobAttempts, retry: true },
    };
  }

  return {
    say: 'That still does not match after two tries. Apologise, tell them the clinic will follow up directly to confirm their details, and end the call warmly. Do not ask the clinical questions.',
    detail: { verified: false, attempts: state.dobAttempts, retry: false },
  };
}

const HANDLERS: Record<string, (state: CallState, args: Record<string, unknown>) => Promise<ToolResult>> = {
  verifyIdentity,
  chartLive,
  chartRiskAnswer,
  recordConcern,
  getCareContext,
  checkCoverage,
  submitQuestionnaire: (state) => submitQuestionnaire(state),
};

export async function dispatchTool(input: {
  state: CallState;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}): Promise<ToolResult> {
  const { state, toolCallId, name, args } = input;

  if (toolCallId && state.handledCallIds.has(toolCallId)) {
    logger.debug({ callId: state.callId, toolCallId, name }, 'tools.duplicate.ignored');
    return { say: 'Already handled. Continue.' };
  }
  if (toolCallId) state.handledCallIds.add(toolCallId);

  const handler = HANDLERS[name];
  if (!handler) {
    logger.warn({ callId: state.callId, name }, 'tools.unknown');
    return { say: 'That action is not available. Continue with the check-in.' };
  }

  try {
    const result = await handler(state, args);
    logger.debug({ callId: state.callId, name, detail: result.detail }, 'tools.dispatched');
    return result;
  } catch (error) {
    logger.error({ callId: state.callId, name, err: String(error) }, 'tools.failed');
    return { say: 'I could not do that just now. Continue with the check-in.' };
  }
}

export function toCallOutcome(state: CallState): CallOutcome {
  const answers: InstrumentAnswer[] = [...state.answers.entries()].map(([linkId, value]) => ({
    linkId,
    value,
  }));
  const riskAnswers: RiskAnswer[] = [...state.riskAnswers.entries()].map(([linkId, value]) => ({
    linkId,
    value,
  }));
  return {
    callId: state.callId,
    patientId: state.context.patientId,
    moduleId: state.context.moduleId,
    answers,
    riskAnswers,
    concerns: state.concerns,
    startedAt: state.startedAt,
    endedAt: new Date().toISOString(),
  };
}
