import { env, isLive } from '../config/env.js';
import { logger } from '../logger.js';

/**
 * Post-call workers only. The live conversation is driven by Deepgram's own
 * agent; this provider is used for evidence synthesis and the expert panel,
 * both of which are advisory and both of which have deterministic fallbacks.
 */

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmResult {
  text: string;
  live: boolean;
}

const TIMEOUT_MS = 25_000;

async function callGroq(request: LlmRequest): Promise<string> {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.llm.groqApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.llm.groqModel,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 800,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Groq HTTP ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return body.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(request: LlmRequest): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.llm.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.llm.anthropicModel,
      max_tokens: request.maxTokens ?? 800,
      temperature: request.temperature ?? 0.2,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Anthropic HTTP ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
  return (body.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

export async function complete(request: LlmRequest): Promise<LlmResult> {
  if (!isLive('llm')) {
    return { text: '', live: false };
  }
  try {
    const text =
      env.llm.provider === 'anthropic' ? await callAnthropic(request) : await callGroq(request);
    return { text, live: text.trim().length > 0 };
  } catch (error) {
    logger.warn({ provider: env.llm.provider, err: String(error) }, 'llm.request.failed');
    return { text: '', live: false };
  }
}

/**
 * Models are asked for a single JSON object. Anything else — prose, fenced
 * blocks, truncation — is treated as a failure so the caller falls back to
 * deterministic text rather than half-parsing a clinical rationale.
 */
export function parseJsonObject<T>(text: string): T | undefined {
  if (!text) return undefined;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}
