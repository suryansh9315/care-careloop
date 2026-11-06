import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { env, isLive } from '../config/env.js';
import { logger } from '../logger.js';

/**
 * Deepgram Voice Agent socket.
 *
 * Deepgram performs speech recognition, turn-taking, response generation and
 * text-to-speech. The bridge owns everything the model is *allowed* to do: the
 * function declarations below are the complete surface. The model never
 * receives Medplum, Stedi or Moss credentials and never calls them directly —
 * it emits a function call, and the bridge decides what actually happens.
 */

export interface AgentFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AgentSettings {
  prompt: string;
  greeting: string;
  functions: AgentFunctionDeclaration[];
  /** Twilio media streams are 8 kHz mu-law in both directions. */
  encoding?: 'mulaw' | 'linear16';
  sampleRate?: number;
  listenModel?: string;
  speakModel?: string;
  thinkModel?: string;
}

export interface AgentFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export declare interface DeepgramAgent {
  on(event: 'open', listener: () => void): this;
  on(event: 'audio', listener: (chunk: Buffer) => void): this;
  on(event: 'functionCall', listener: (call: AgentFunctionCall) => void): this;
  on(event: 'transcript', listener: (role: string, text: string) => void): this;
  on(event: 'userStartedSpeaking', listener: () => void): this;
  on(event: 'agentAudioDone', listener: () => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export class DeepgramAgent extends EventEmitter {
  private socket?: WebSocket;
  private keepAlive?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly settings: AgentSettings) {
    super();
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (!isLive('deepgram')) {
      logger.warn('deepgram.mock.enabled — no voice agent socket will be opened');
      queueMicrotask(() => this.emit('open'));
      return;
    }

    const socket = new WebSocket(env.deepgram.agentUrl, ['token', env.deepgram.apiKey]);
    this.socket = socket;

    socket.on('open', () => {
      socket.send(JSON.stringify(this.buildSettingsMessage()));
      // Deepgram closes idle sockets; Twilio silence is common mid-call.
      this.keepAlive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 8_000);
      logger.info('deepgram.agent.open');
      this.emit('open');
    });

    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        this.emit('audio', Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      this.handleControlMessage(data.toString());
    });

    socket.on('error', (error) => {
      logger.error({ err: String(error) }, 'deepgram.agent.error');
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    });

    socket.on('close', () => {
      this.cleanup();
      logger.info('deepgram.agent.close');
      this.emit('close');
    });
  }

  private buildSettingsMessage(): unknown {
    const encoding = this.settings.encoding ?? 'mulaw';
    const sampleRate = this.settings.sampleRate ?? 8000;
    return {
      type: 'Settings',
      audio: {
        input: { encoding, sample_rate: sampleRate },
        output: { encoding, sample_rate: sampleRate, container: 'none' },
      },
      agent: {
        language: 'en',
        listen: {
          provider: { type: 'deepgram', model: this.settings.listenModel ?? 'nova-3' },
        },
        think: {
          provider: {
            type: 'open_ai',
            model: this.settings.thinkModel ?? env.deepgram.thinkModel,
            temperature: 0.2,
          },
          prompt: this.settings.prompt,
          functions: this.settings.functions.map((fn) => ({
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters,
          })),
        },
        speak: {
          provider: { type: 'deepgram', model: this.settings.speakModel ?? 'aura-2-thalia-en' },
        },
        greeting: this.settings.greeting,
      },
    };
  }

  private handleControlMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      logger.debug({ raw: raw.slice(0, 200) }, 'deepgram.message.unparsed');
      return;
    }

    switch (message.type) {
      case 'FunctionCallRequest': {
        // Deepgram batches function calls; each gets its own bridge dispatch.
        const calls: any[] = message.functions ?? [message];
        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try {
            args =
              typeof call.arguments === 'string'
                ? JSON.parse(call.arguments || '{}')
                : (call.arguments ?? {});
          } catch {
            logger.warn({ name: call.name }, 'deepgram.functioncall.bad-arguments');
          }
          this.emit('functionCall', {
            id: String(call.id ?? message.id ?? ''),
            name: String(call.name ?? ''),
            args,
          });
        }
        break;
      }
      case 'ConversationText':
        this.emit('transcript', String(message.role ?? 'unknown'), String(message.content ?? ''));
        break;
      case 'UserStartedSpeaking':
        this.emit('userStartedSpeaking');
        break;
      case 'AgentAudioDone':
        this.emit('agentAudioDone');
        break;
      case 'Error':
        logger.error({ description: message.description }, 'deepgram.agent.reported-error');
        break;
      case 'SettingsApplied':
        logger.info({ functions: this.settings.functions.length }, 'deepgram.settings.applied');
        break;
      case 'PromptUpdated':
        logger.info('deepgram.prompt.updated');
        break;
      case 'Warning':
        logger.warn({ description: message.description }, 'deepgram.agent.warning');
        break;
      default:
        logger.debug({ type: message.type }, 'deepgram.message');
    }
  }

  sendAudio(chunk: Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(chunk, { binary: true });
    }
  }

  /**
   * Append to the running system prompt mid-call (state mode advances the
   * flow with this). Per Deepgram docs, UpdatePrompt ADDS to — not replaces —
   * the current prompt, capped at 25,000 characters on managed LLMs, and it
   * carries ONLY the prompt: the function list is fixed at Settings time,
   * which is why every mode declares all tools upfront and gates them through
   * the prompt text instead. Keep payloads small; the cap is cumulative.
   */
  updatePrompt(prompt: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'UpdatePrompt', prompt }));
  }

  respondToFunctionCall(id: string, name: string, content: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        type: 'FunctionCallResponse',
        id,
        name,
        content: typeof content === 'string' ? content : JSON.stringify(content),
      }),
    );
  }

  /** Ask the agent to say something verbatim — used for deterministic flow recovery. */
  injectMessage(text: string, behavior: 'default' | 'queue' | 'interrupt' = 'default'): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'InjectAgentMessage', message: text, behavior }));
  }

  private cleanup(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = undefined;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  }
}
