import type WebSocket from 'ws';
import { getModule } from '../conditions/registry.js';
import { env } from '../config/env.js';
import { DeepgramAgent } from '../integrations/deepgram.js';
import { logger } from '../logger.js';
import { runPostCallPipeline } from '../orchestration/postcall.js';
import { buildAgentPrompt, buildGreeting } from '../orchestration/prompt.js';
import type { StateModeView } from '../orchestration/renderers.js';
import { FlowStateMachine, isNoMoreResponse } from '../orchestration/statemachine.js';
import {
  AGENT_FUNCTIONS,
  createCallState,
  dispatchTool,
  toCallOutcome,
  type CallState,
} from '../orchestration/tools.js';
import type { PatientContext } from '../types.js';

/**
 * One CallSession per phone call.
 *
 * Everything mutable — the Deepgram socket, the answer map, the concerns, the
 * tool-call idempotency set — lives on the instance. Nothing is shared between
 * calls, so a failure in one call cannot corrupt another. Medplum is reached
 * through a stateless client, so there is no per-call connection to leak.
 */
/** Seconds of grace after submission so the closing recap actually plays. */
const HANGUP_GRACE_MS = 10_000;
/** Do not persist while Deepgram may still be emitting the same user turn. */
const ANSWER_SETTLE_MS = 900;
const FIRST_SILENCE_NUDGE_MS = 6_500;
const QUESTION_REPEAT_MS = 7_000;
const BACKCHANNEL_GRACE_MS = 1_800;
const ASSISTANT_AUDIO_QUIET_MS = 700;

export class CallSession {
  readonly state: CallState;
  /** Twilio call SID, set once the call is placed. Used by the call log. */
  callSid?: string;
  private agent?: DeepgramAgent;
  /** Set only under ORCH_MODE=state; the bridge then drives the interview. */
  private machine?: FlowStateMachine;
  private twilioSocket?: WebSocket;
  private streamSid?: string;
  private ended = false;
  /** Once set, the model can neither speak nor invoke another call-flow tool. */
  private closingStarted = false;
  private postCallStarted = false;
  private hangupTimer?: NodeJS.Timeout;
  /** Current node already given the just-in-time answer-capture reminder. */
  private captureNudgedNodeId?: string;
  /** Nodes for which a substantive patient answer was actually transcribed. */
  private readonly answeredNodeIds = new Set<string>();
  private readonly lastAnswerAtByNode = new Map<string, number>();
  private readonly chartingNodeIds = new Set<string>();
  /** Bridge-owned questions are initiated at most once per state node. */
  private readonly deliveredQuestionNodeIds = new Set<string>();
  private hearingRepairCount = 0;
  private silenceRepeatCount = 0;
  private questionTimer?: NodeJS.Timeout;
  private awaitingQuestionAudioDone = false;
  private awaitingSilenceNudgeAudioDone = false;
  private resumeAfterAgentAudio?: string;
  private resumeFallbackTimer?: NodeJS.Timeout;
  private expectedInjectedSpeech?: string;
  private allowModelAnswer = false;
  private activeBridgeSpeech?: 'question' | 'nudge' | 'closing';
  private deliveryWatchdog?: NodeJS.Timeout;
  private deliveryRetryCount = 0;
  private waitingForQaToolQuestion?: string;
  private qaToolWaitTimer?: NodeJS.Timeout;
  private readonly toolFailuresByNode = new Map<string, number>();
  private backchannelTimer?: NodeJS.Timeout;
  private qaAnswerQuietTimer?: NodeJS.Timeout;
  private correctedChartTimer?: NodeJS.Timeout;

  constructor(
    readonly callId: string,
    readonly context: PatientContext,
  ) {
    this.state = createCallState(callId, context);
  }

  attachTwilio(socket: WebSocket): void {
    this.twilioSocket = socket;

    socket.on('message', (raw) => {
      let message: any;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleTwilioMessage(message);
    });

    socket.on('close', () => void this.end('twilio-close'));
    socket.on('error', (error) => {
      logger.warn({ callId: this.callId, err: String(error) }, 'twilio.socket.error');
      void this.end('twilio-error');
    });
  }

  /** Public so a deferred attach can replay the `start` frame it consumed. */
  handleTwilioMessage(message: any): void {
    switch (message.event) {
      case 'start':
        this.streamSid = message.start?.streamSid;
        logger.info({ callId: this.callId, streamSid: this.streamSid }, 'twilio.stream.start');
        this.startAgent();
        break;
      case 'media':
        if (message.media?.payload) {
          this.agent?.sendAudio(Buffer.from(message.media.payload, 'base64'));
        }
        break;
      case 'stop':
        logger.info({ callId: this.callId }, 'twilio.stream.stop');
        void this.end('twilio-stop');
        break;
      default:
        break;
    }
  }

  private startAgent(): void {
    if (this.agent) return;
    const module = getModule(this.context.moduleId);

    if (env.orchMode === 'state') {
      this.machine = new FlowStateMachine(module, this.context);
    }

    const agent = new DeepgramAgent({
      prompt: buildAgentPrompt({ module, context: this.context }),
      greeting: buildGreeting(this.context),
      // Full list in both modes: Deepgram fixes the function set at Settings
      // time, so state mode gates tools through the per-node prompt instead.
      functions: AGENT_FUNCTIONS,
    });
    this.agent = agent;

    // Injected questions use the same Deepgram TTS stream as ordinary agent
    // speech. Forward it immediately; holding a full utterance caused long
    // silence and made callers say "hello?" before hearing the question.
    agent.on('audio', (chunk) => {
      // Transcript suppression is too late: Deepgram may already have emitted
      // audio. During closing, forward only the bridge-injected goodbye.
      if (this.closingStarted && this.activeBridgeSpeech !== 'closing') return;
      this.sendToTwilio(chunk);
    });

    agent.on('agentAudioDone', () => {
      const bridgeSpeech = this.activeBridgeSpeech;
      if (bridgeSpeech) {
        this.activeBridgeSpeech = undefined;
        this.expectedInjectedSpeech = undefined;
      }
      if (bridgeSpeech === 'question') {
        this.clearDeliveryWatchdog();
        this.awaitingQuestionAudioDone = false;
        this.startFirstSilenceTimer();
        return;
      }
      if (bridgeSpeech === 'nudge') {
        this.awaitingSilenceNudgeAudioDone = false;
        this.questionTimer = setTimeout(() => {
          if (this.silenceRepeatCount >= 1) {
            this.finishForSilence();
            return;
          }
          const current = this.machine?.view()?.spoken;
          if (current) this.speakQuestion(current, 'silence');
        }, QUESTION_REPEAT_MS);
        this.questionTimer.unref();
        return;
      }
      if (bridgeSpeech === 'closing') return;
      if (this.resumeAfterAgentAudio) {
        this.scheduleQaResumeAfterQuiet();
      }
    });

    agent.on('userStartedSpeaking', () => {
      // Barge-in: drop anything Twilio has buffered so the patient is not
      // talking over a sentence the agent has already committed to.
      this.clearTwilioAudio();
      this.clearQuestionTimer();
      this.clearDeliveryWatchdog();
      this.awaitingQuestionAudioDone = false;
      this.awaitingSilenceNudgeAudioDone = false;
      this.activeBridgeSpeech = undefined;
      this.clearBackchannelTimer();
    });

    agent.on('functionCall', (call) => {
      void (async () => {
        // Logged at info: during a live call this is the only visibility into
        // whether the agent is actually driving the flow or just talking.
        logger.info({ callId: this.callId, tool: call.name, args: call.args }, 'call.tool.requested');
        if (this.ended || this.closingStarted) {
          logger.warn({ callId: this.callId, tool: call.name }, 'call.tool.rejected.closing');
          agent.respondToFunctionCall(call.id, call.name, 'IGNORED. The bridge is closing the call. Do not speak.');
          return;
        }
        if (this.machine && call.name === 'submitQuestionnaire') {
          logger.warn({ callId: this.callId, node: this.machine.currentNodeId }, 'call.tool.rejected.bridge-owned-submit');
          agent.respondToFunctionCall(
            call.id,
            call.name,
            'IGNORED. Submission is owned by the bridge. Do not speak and wait for the patient.',
          );
          return;
        }
        if (call.name === 'getCareContext' || call.name === 'checkCoverage') this.clearQaToolWait();
        if (call.name === 'chartLive' || call.name === 'chartRiskAnswer') this.clearCorrectedChartWatchdog();
        const currentNodeId = this.machine?.currentNodeId;
        const rejection = this.machine?.chartCallRejection(
          call.name,
          call.args,
          currentNodeId ? this.answeredNodeIds.has(currentNodeId) : false,
        );
        if (rejection) {
          logger.warn(
            { callId: this.callId, tool: call.name, args: call.args, node: currentNodeId, reason: rejection },
            'call.tool.rejected',
          );
          agent.respondToFunctionCall(call.id, call.name, 'IGNORED. Do not speak. Wait for the bridge.');
          return;
        }
        let reservedNodeId: string | undefined;
        if (
          currentNodeId &&
          (call.name === 'chartLive' || call.name === 'chartRiskAnswer')
        ) {
          if (this.chartingNodeIds.has(currentNodeId)) {
            logger.warn({ callId: this.callId, tool: call.name, node: currentNodeId }, 'call.tool.in-flight');
            agent.respondToFunctionCall(
              call.id,
              call.name,
              'IGNORED: this answer is already being recorded. Remain silent and wait for the next question.',
            );
            return;
          }
          // Reserve before settling. Two function calls can otherwise enter
          // the quiet-period wait together and both write/speak afterward.
          this.chartingNodeIds.add(currentNodeId);
          reservedNodeId = currentNodeId;
          // ConversationText can split one answer into multiple messages.
          // Wait until it has been quiet before committing the model's map.
          const answerVersionAtRequest = this.lastAnswerAtByNode.get(currentNodeId) ?? 0;
          while (Date.now() - (this.lastAnswerAtByNode.get(currentNodeId) ?? 0) < ANSWER_SETTLE_MS) {
            await new Promise((resolve) => setTimeout(resolve, 75));
          }
          if (this.machine?.currentNodeId !== currentNodeId) {
            this.chartingNodeIds.delete(currentNodeId);
            agent.respondToFunctionCall(call.id, call.name, 'IGNORED: the flow already advanced. Remain silent.');
            return;
          }
          if ((this.lastAnswerAtByNode.get(currentNodeId) ?? 0) !== answerVersionAtRequest) {
            this.chartingNodeIds.delete(currentNodeId);
            agent.respondToFunctionCall(
              call.id,
              call.name,
              'IGNORED: the patient continued their answer. Do not speak; map the complete latest answer and call the same tool once.',
            );
            this.startCorrectedChartWatchdog(currentNodeId);
            return;
          }
        }
        try {
          const result = await dispatchTool({
          state: this.state,
          toolCallId: call.id,
          name: call.name,
          args: call.args,
        });
        // Advance the flow BEFORE responding: the next node's cue rides the
        // function result, which the model reads before its next utterance —
        // the UpdatePrompt nudge alone arrives one turn too late.
        const view = this.machine?.onToolResult(call.name, result.detail);
        if (call.name === 'verifyIdentity' && result.detail?.verified !== true) {
          agent.respondToFunctionCall(call.id, call.name, 'Do not speak. The bridge will handle verification.');
          if (result.detail?.retry === true) {
            this.speakQuestion(
              'That didn’t match our records. Please say your full date of birth once more — month, day, and year.',
              'dob-retry',
            );
          } else {
            this.clearQuestionTimer();
            this.injectControlledSpeech(
              'I’m sorry, I couldn’t verify the details. The clinic will follow up directly. Take care.',
              'closing',
            );
            this.scheduleHangup();
          }
          return;
        }
        const conversationalNode = this.machine?.currentNode?.kind;
        if (
          !view &&
          this.machine?.view()?.spoken &&
          (call.name === 'getCareContext' || call.name === 'checkCoverage')
        ) {
          const question = this.machine.view()?.spoken;
          this.allowModelAnswer = true;
          agent.respondToFunctionCall(
            call.id,
            call.name,
            `${result.say} Answer briefly, then stop. Do not repeat the scripted question; the bridge will resume it.`,
          );
          if (question) this.scheduleResumeAfterAgentAudio(question);
          return;
        }
        if (
          !view &&
          (conversationalNode === 'open-concerns' || conversationalNode === 'recap') &&
          call.name === 'recordConcern'
        ) {
          agent.respondToFunctionCall(
            call.id,
            call.name,
            'RECORDED. Do not speak and do not repeat the scripted concerns question. The bridge will follow up.',
          );
          this.hearingRepairCount = 0;
          this.silenceRepeatCount = 0;
          this.speakQuestion('I’ve noted that. Is there anything else you would like me to add?', 'resume');
          return;
        }
        // Questionnaire questions are spoken by the bridge, never composed by
        // the model. A silent function result prevents the result and the
        // UpdatePrompt from independently producing the same next question.
        const content = view?.spoken
          ? 'RECORDED. Do not speak or ask the next question. The bridge will speak it.'
          : view?.cue
            ? `${result.say}\n\nNEXT STEP → ${view.cue}`
            : result.say;
        agent.respondToFunctionCall(call.id, call.name, content);
        this.followFlow(view);

        // Submission is the signal that the clinical content of the call is
        // complete. The pipeline starts now so the patient never waits on it.
        if (call.name === 'submitQuestionnaire' && this.state.submitted) {
          this.startPostCall('questionnaire-submitted');
          this.scheduleHangup();
        }
        } catch (error) {
          logger.error({ callId: this.callId, tool: call.name, err: String(error) }, 'call.tool.failed');
          agent.respondToFunctionCall(call.id, call.name, 'Do not speak. The bridge will recover the call.');
          const currentView = this.machine?.view();
          const failureKey = currentView?.nodeId ?? call.name;
          const failures = (this.toolFailuresByNode.get(failureKey) ?? 0) + 1;
          this.toolFailuresByNode.set(failureKey, failures);
          if (currentView?.spoken && failures === 1) {
            this.speakQuestion(`I’m sorry, I had trouble saving that. ${currentView.spoken}`, 'tool-retry');
          } else {
            this.clearQuestionTimer();
            this.injectControlledSpeech('I’m sorry, I’m having a technical problem. The clinic will follow up. Take care.', 'closing');
            this.scheduleHangup();
          }
        } finally {
          if (reservedNodeId) this.chartingNodeIds.delete(reservedNodeId);
        }
      })();
    });

    agent.on('transcript', (role, text) => {
      logger.info({ callId: this.callId, role, text }, 'call.transcript');
      if (role === 'assistant') {
        const normalized = normalizeSpoken(text);
        const unsafe = /\b(waiting|duplicate message|end of conversation|system message|no new content)\b/i.test(text);
        const expected = this.expectedInjectedSpeech;
        const expectedSpeech = Boolean(expected && (expected.includes(normalized) || normalized.includes(expected)));
        if (this.closingStarted && !expectedSpeech) {
          this.clearTwilioAudio();
          logger.warn({ callId: this.callId, node: this.machine?.currentNodeId, text }, 'call.assistant-speech.suppressed');
          return;
        }
        if (unsafe || (this.machine?.view()?.spoken && !expectedSpeech && !this.allowModelAnswer)) {
          this.clearTwilioAudio();
          logger.warn({ callId: this.callId, node: this.machine?.currentNodeId, text }, 'call.assistant-speech.suppressed');
        }
      }
      if (role === 'user') {
        if (this.closingStarted || this.ended) return;
        this.clearBackchannelTimer();
        const nodeId = this.machine?.currentNodeId;
        const currentView = this.machine?.view();
        if (
          (this.machine?.currentNode?.kind === 'open-concerns' ||
            this.machine?.currentNode?.kind === 'recap') &&
          isNoMoreResponse(text)
        ) {
          this.clearQuestionTimer();
          void this.submitAndClose();
          return;
        }
        if (currentView?.spoken) {
          const yesNoQuestion = this.machine?.currentNode?.meta?.expects === 'yes-no';
          const turn = classifyUserTurn(text, yesNoQuestion);
          if (turn === 'repair') {
            if (this.hearingRepairCount >= 1) this.startFirstSilenceTimer();
            else this.speakQuestion(currentView.spoken, 'repair');
            return;
          }
          if (turn === 'backchannel') {
            this.scheduleBackchannelRecovery(currentView.spoken);
            return;
          }
          if (turn === 'patient-question') {
            this.clearQuestionTimer();
            this.waitForQaTool(currentView.spoken);
            return;
          }
          this.clearQuestionTimer();
        }
        if (nodeId) {
          const captureNudge = this.machine?.answerCaptureNudge(text);
          if (captureNudge) {
            this.answeredNodeIds.add(nodeId);
            this.lastAnswerAtByNode.set(nodeId, Date.now());
            if (this.captureNudgedNodeId !== nodeId) {
              this.captureNudgedNodeId = nodeId;
              agent.updatePrompt(captureNudge);
              logger.info({ callId: this.callId, node: nodeId }, 'flow.answer-capture');
            }
          }
        }
        this.followFlow(this.machine?.onUserTurn(text));
      }
    });

    agent.on('error', () => void this.end('agent-error'));
    agent.on('close', () => void this.end('agent-close'));

    agent.connect();
  }

  /**
   * State mode only: push the next node's instruction to the live agent. The
   * compact nudge — not the full prompt — because Deepgram truncates long
   * UpdatePrompt payloads, and a truncated instruction mid-call is worse than
   * a short one.
   */
  private followFlow(view?: StateModeView): void {
    if (!view || !this.agent) return;
    this.agent.updatePrompt(view.nudge);
    logger.info({ callId: this.callId, node: view.nodeId }, 'flow.advance');
    if (view.spoken && !this.deliveredQuestionNodeIds.has(view.nodeId)) {
      this.deliveredQuestionNodeIds.add(view.nodeId);
      this.hearingRepairCount = 0;
      this.silenceRepeatCount = 0;
      this.deliveryRetryCount = 0;
      this.speakQuestion(view.spoken, 'initial');
      logger.info({ callId: this.callId, node: view.nodeId }, 'flow.question.injected');
    }
  }

  private speakQuestion(text: string, reason: QuestionSpeakReason = 'initial'): void {
    if (!this.agent) return;
    if (reason === 'repair') {
      if (this.hearingRepairCount >= 1) return;
      this.hearingRepairCount += 1;
    }
    if (reason === 'silence') {
      if (this.silenceRepeatCount >= 1) return;
      this.silenceRepeatCount += 1;
    }
    this.clearQuestionTimer();
    this.clearTwilioAudio();
    this.awaitingSilenceNudgeAudioDone = false;
    this.awaitingQuestionAudioDone = true;
    this.injectControlledSpeech(text, 'question');
    this.startDeliveryWatchdog(text);
  }

  private startFirstSilenceTimer(): void {
    this.clearQuestionTimer();
    this.questionTimer = setTimeout(() => {
      this.awaitingSilenceNudgeAudioDone = true;
      this.injectControlledSpeech('Take your time.', 'nudge', 'queue');
    }, FIRST_SILENCE_NUDGE_MS);
    this.questionTimer.unref();
  }

  private scheduleResumeAfterAgentAudio(question: string): void {
    this.resumeAfterAgentAudio = question;
    this.clearResumeFallback();
    this.resumeFallbackTimer = setTimeout(() => {
      if (this.resumeAfterAgentAudio !== question) return;
      this.resumeAfterAgentAudio = undefined;
      this.speakQuestion(question, 'resume');
    }, 12_000);
    this.resumeFallbackTimer.unref();
  }

  private scheduleQaResumeAfterQuiet(): void {
    if (!this.resumeAfterAgentAudio) return;
    if (this.qaAnswerQuietTimer) clearTimeout(this.qaAnswerQuietTimer);
    this.qaAnswerQuietTimer = setTimeout(() => {
      const question = this.resumeAfterAgentAudio;
      if (!question) return;
      this.resumeAfterAgentAudio = undefined;
      this.clearResumeFallback();
      this.speakQuestion(question, 'resume');
    }, ASSISTANT_AUDIO_QUIET_MS);
    this.qaAnswerQuietTimer.unref();
  }

  private scheduleBackchannelRecovery(question: string): void {
    this.clearBackchannelTimer();
    this.backchannelTimer = setTimeout(() => {
      if (this.machine?.view()?.spoken !== question) return;
      if (this.hearingRepairCount >= 1) this.startFirstSilenceTimer();
      else this.speakQuestion(question, 'repair');
    }, BACKCHANNEL_GRACE_MS);
    this.backchannelTimer.unref();
  }

  private clearBackchannelTimer(): void {
    if (!this.backchannelTimer) return;
    clearTimeout(this.backchannelTimer);
    this.backchannelTimer = undefined;
  }

  private waitForQaTool(question: string): void {
    this.clearQaToolWait();
    this.waitingForQaToolQuestion = question;
    this.qaToolWaitTimer = setTimeout(() => {
      if (this.waitingForQaToolQuestion !== question) return;
      this.waitingForQaToolQuestion = undefined;
      this.speakQuestion(question, 'resume');
    }, 12_000);
    this.qaToolWaitTimer.unref();
  }

  private clearQaToolWait(): void {
    this.waitingForQaToolQuestion = undefined;
    if (!this.qaToolWaitTimer) return;
    clearTimeout(this.qaToolWaitTimer);
    this.qaToolWaitTimer = undefined;
  }

  private startCorrectedChartWatchdog(nodeId: string): void {
    this.clearCorrectedChartWatchdog();
    this.correctedChartTimer = setTimeout(() => {
      if (this.machine?.currentNodeId !== nodeId) return;
      this.agent?.updatePrompt(
        'The patient continued their answer. Do not speak. Map the complete latest answer now and call the current chart tool once.',
      );
      this.correctedChartTimer = setTimeout(() => {
        if (this.machine?.currentNodeId !== nodeId) return;
        const question = this.machine?.view()?.spoken;
        if (question) this.speakQuestion(question, 'resume');
      }, 3_000);
      this.correctedChartTimer.unref();
    }, 2_500);
    this.correctedChartTimer.unref();
  }

  private clearCorrectedChartWatchdog(): void {
    if (!this.correctedChartTimer) return;
    clearTimeout(this.correctedChartTimer);
    this.correctedChartTimer = undefined;
  }

  private startDeliveryWatchdog(question: string): void {
    this.clearDeliveryWatchdog();
    this.deliveryWatchdog = setTimeout(() => {
      if (!this.awaitingQuestionAudioDone) return;
      this.awaitingQuestionAudioDone = false;
      if (this.deliveryRetryCount < 1) {
        this.deliveryRetryCount += 1;
        this.speakQuestion(question, 'delivery-retry');
        return;
      }
      this.injectControlledSpeech('I’m sorry, the connection is not working properly. The clinic will follow up. Take care.', 'closing');
      this.scheduleHangup();
    }, 15_000);
    this.deliveryWatchdog.unref();
  }

  private clearDeliveryWatchdog(): void {
    if (!this.deliveryWatchdog) return;
    clearTimeout(this.deliveryWatchdog);
    this.deliveryWatchdog = undefined;
  }

  private finishForSilence(): void {
    this.clearQuestionTimer();
    this.injectControlledSpeech('It sounds like now may not be a good time. The clinic can follow up with you. Take care.', 'closing');
    this.scheduleHangup();
  }

  private clearResumeFallback(): void {
    if (this.resumeFallbackTimer) {
      clearTimeout(this.resumeFallbackTimer);
      this.resumeFallbackTimer = undefined;
    }
    if (this.qaAnswerQuietTimer) {
      clearTimeout(this.qaAnswerQuietTimer);
      this.qaAnswerQuietTimer = undefined;
    }
  }

  private clearQuestionTimer(): void {
    if (!this.questionTimer) return;
    clearTimeout(this.questionTimer);
    this.questionTimer = undefined;
  }

  private clearTwilioAudio(): void {
    if (!this.twilioSocket || !this.streamSid || this.twilioSocket.readyState !== 1) return;
    this.twilioSocket.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
  }

  private injectControlledSpeech(
    text: string,
    kind: 'question' | 'nudge' | 'closing',
    behavior: 'queue' | 'interrupt' = 'interrupt',
  ): void {
    if (!this.agent) return;
    this.expectedInjectedSpeech = normalizeSpoken(text);
    this.allowModelAnswer = false;
    this.activeBridgeSpeech = kind;
    this.agent.injectMessage(text, behavior);
  }

  private sendToTwilio(chunk: Buffer): void {
    if (!this.twilioSocket || !this.streamSid) return;
    if (this.twilioSocket.readyState !== 1) return;
    this.twilioSocket.send(
      JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: chunk.toString('base64') },
      }),
    );
  }

  /** Persist once and deliver one bridge-owned goodbye; the model is locked out. */
  private async submitAndClose(): Promise<void> {
    if (this.closingStarted || this.ended) return;
    this.closingStarted = true;
    this.clearQuestionTimer();
    this.clearResumeFallback();
    this.clearDeliveryWatchdog();
    this.clearQaToolWait();
    this.clearBackchannelTimer();
    this.clearCorrectedChartWatchdog();
    this.clearTwilioAudio();
    this.agent?.updatePrompt('The bridge is closing the call. Do not speak and do not call any tools.');

    const result = await dispatchTool({
      state: this.state,
      toolCallId: `bridge-submit:${this.callId}`,
      name: 'submitQuestionnaire',
      args: {},
    });
    if (this.ended) return;

    if (!this.state.submitted) {
      logger.error({ callId: this.callId, result: result.say }, 'call.bridge-submit.failed');
      this.injectControlledSpeech(
        'I’m sorry, I had trouble saving the check-in. The clinic will follow up directly. Take care.',
        'closing',
      );
      this.scheduleHangup();
      return;
    }

    this.startPostCall('questionnaire-submitted');
    this.injectControlledSpeech(
      `Thank you, ${this.context.fullName.split(/\s+/)[0]}. I’ve recorded your answers for your clinician to review. Take care.`,
      'closing',
    );
    this.scheduleHangup();
  }

  /**
   * Fire-and-forget. Deliberately not awaited anywhere on the call path.
   * Idempotent because both submission and hangup can trigger it.
   */
  startPostCall(reason: string): void {
    if (this.postCallStarted) return;
    if (this.state.answers.size === 0) {
      logger.warn({ callId: this.callId, reason }, 'postcall.skipped.no-answers');
      return;
    }
    this.postCallStarted = true;

    void runPostCallPipeline({
      outcome: toCallOutcome(this.state),
      questionnaireResponse: this.state.questionnaireResponse,
      context: this.context,
    })
      .then((result) => {
        logger.info(
          { callId: this.callId, reason, carePlanId: result.written.carePlanId },
          'postcall.pipeline.done',
        );
      })
      .catch((error) => {
        logger.error({ callId: this.callId, err: String(error) }, 'postcall.pipeline.failed');
      });
  }

  /**
   * End the call ourselves a beat after submission.
   *
   * Without this the line stays open after the recap and the patient is left
   * listening to silence, unsure whether to hang up. The grace period is there
   * so the closing words actually finish playing — hanging up the instant the
   * tool returns would cut Maya off mid-sentence.
   */
  private scheduleHangup(): void {
    if (this.hangupTimer) return;
    this.hangupTimer = setTimeout(() => {
      logger.info({ callId: this.callId }, 'call.autohangup');
      void this.end('recap-complete');
    }, HANGUP_GRACE_MS);
    this.hangupTimer.unref();
  }

  async end(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.hangupTimer) {
      clearTimeout(this.hangupTimer);
      this.hangupTimer = undefined;
    }
    this.clearQuestionTimer();
    this.clearResumeFallback();
    this.clearDeliveryWatchdog();
    this.clearQaToolWait();
    this.clearBackchannelTimer();
    this.clearCorrectedChartWatchdog();
    logger.info({ callId: this.callId, reason, answers: this.state.answers.size }, 'call.ended');

    this.agent?.close();
    if (this.twilioSocket && this.twilioSocket.readyState === 1) {
      this.twilioSocket.close();
    }

    // A call that hung up mid-questionnaire still produces a draft, so the
    // clinician sees a visibly partial record rather than nothing at all.
    this.startPostCall(reason);
  }
}

function normalizeSpoken(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Pure policy kept exported so the audio safety boundary has regression tests. */
type QuestionSpeakReason =
  | 'initial'
  | 'repair'
  | 'silence'
  | 'dob-retry'
  | 'resume'
  | 'delivery-retry'
  | 'tool-retry';

export type UserTurnKind = 'answer' | 'repair' | 'backchannel' | 'patient-question';

/** Keep vague clinical language, but never chart call-repair or filler speech. */
export function classifyUserTurn(text: string, yesNoQuestion = false): UserTurnKind {
  const normalized = normalizeSpoken(text);
  if (!normalized) return 'backchannel';
  if (
    /^(hello|hello there|sorry|pardon|what|what was that|come again)$/i.test(normalized) ||
    /\b(repeat|say that again|didn t hear|cannot hear|can t hear|hear me)\b/i.test(normalized)
  ) {
    return 'repair';
  }
  if (!yesNoQuestion && /^(yes|yeah|yep|okay|ok|alright|right|mhm|uh huh)$/i.test(normalized)) {
    return 'backchannel';
  }
  const explicitQuestion =
    /\b(can you|could you|would you|should i|do i|does it|is it|are there)\b/i.test(normalized) ||
    /^(what|why|when|where|who)\b/i.test(normalized) ||
    (/^how\b/i.test(normalized) && !/^how can i (put|say|explain)\b/i.test(normalized));
  if (explicitQuestion) return 'patient-question';
  const containsClinicalAnswer = /\b(every|daily|nightly|sometimes|often|rarely|never|always|times?|a lot|not much|stairs?|work|school|home|controlled|uncontrolled)\b/i.test(
    normalized,
  );
  if (containsClinicalAnswer) return 'answer';
  if (
    /\?$/.test(text.trim())
  ) {
    return 'patient-question';
  }
  return 'answer';
}

const sessions = new Map<string, CallSession>();

export function registerSession(session: CallSession): void {
  sessions.set(session.callId, session);
}

export function getSession(callId: string): CallSession | undefined {
  return sessions.get(callId);
}

export function removeSession(callId: string): void {
  sessions.delete(callId);
}

export function activeSessionCount(): number {
  return sessions.size;
}

/**
 * Binds an incoming Twilio media socket to its CallSession.
 *
 * The URL query string is only a hint. Twilio does not reliably carry it to
 * the media stream socket, so the authoritative identifier is the `callId`
 * `<Parameter>` delivered in the `start` frame. When the hint is absent the
 * socket is accepted and held until that frame arrives, then the frame is
 * replayed into the session so no audio or state is lost.
 */
export function routeTwilioSocket(socket: WebSocket, callIdHint?: string): void {
  const hinted = callIdHint ? getSession(callIdHint) : undefined;
  if (hinted) {
    hinted.attachTwilio(socket);
    return;
  }

  const giveUp = setTimeout(() => {
    logger.warn('twilio.stream.no-start-frame');
    socket.close();
  }, 15_000);

  const onMessage = (raw: WebSocket.RawData): void => {
    let message: any;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.event !== 'start') return;

    const callId: string | undefined =
      message.start?.customParameters?.callId ?? message.start?.customParameters?.callid;
    const session = callId ? getSession(callId) : undefined;

    clearTimeout(giveUp);
    socket.off('message', onMessage);

    if (!session) {
      logger.warn({ callId: callId ?? '(none)' }, 'twilio.stream.unresolved');
      socket.close();
      return;
    }

    logger.info({ callId }, 'twilio.stream.resolved-from-parameter');
    session.attachTwilio(socket);
    session.handleTwilioMessage(message);
  };

  socket.on('message', onMessage);
}
