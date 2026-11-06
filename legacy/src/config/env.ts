import 'dotenv/config';

function str(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value.trim();
}

function num(name: string, fallback: number): number {
  const parsed = Number(str(name));
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : fallback;
}

export const env = {
  port: num('PORT', 3000),
  publicHost: str('PUBLIC_HOST'),
  logLevel: str('LOG_LEVEL', 'info'),
  /**
   * `prompt` flattens the flow into one system prompt; `state` walks node by
   * node, with the bridge advancing the interview and re-prompting the agent
   * via Deepgram's UpdatePrompt (see `src/orchestration/statemachine.ts`).
   * Deepgram fixes the function list at Settings time, so both modes declare
   * every tool upfront; state mode gates them through the per-node prompt.
   */
  orchMode: (str('ORCH_MODE', 'state') === 'prompt' ? 'prompt' : 'state') as 'prompt' | 'state',
  toolSharedSecret: str('TOOL_SHARED_SECRET', 'dev-secret'),

  medplum: {
    baseUrl: str('MEDPLUM_BASE_URL', 'https://api.medplum.com/'),
    clientId: str('MEDPLUM_CLIENT_ID'),
    clientSecret: str('MEDPLUM_CLIENT_SECRET'),
  },

  twilio: {
    accountSid: str('TWILIO_ACCOUNT_SID'),
    authToken: str('TWILIO_AUTH_TOKEN'),
    phoneNumber: str('TWILIO_PHONE_NUMBER'),
  },

  deepgram: {
    apiKey: str('DEEPGRAM_API_KEY'),
    agentUrl: str('DEEPGRAM_AGENT_URL', 'wss://agent.deepgram.com/v1/agent/converse'),
    // Use a conventional low-latency chat/tool model for the live call. The
    // reasoning-model default emitted stage directions and speculative tools.
    thinkModel: str('DEEPGRAM_THINK_MODEL', 'gpt-4o'),
  },

  llm: {
    provider: str('LLM_PROVIDER', 'none') as 'groq' | 'anthropic' | 'none',
    groqApiKey: str('GROQ_API_KEY'),
    groqModel: str('GROQ_MODEL', 'llama-3.3-70b-versatile'),
    anthropicApiKey: str('ANTHROPIC_API_KEY'),
    anthropicModel: str('ANTHROPIC_MODEL', 'claude-opus-4-5'),
  },

  moss: {
    projectId: str('MOSS_PROJECT_ID'),
    projectKey: str('MOSS_PROJECT_KEY'),
  },

  stedi: {
    apiKey: str('STEDI_API_KEY'),
    baseUrl: str('STEDI_BASE_URL', 'https://healthcare.us.stedi.com'),
    payerId: str('STEDI_PAYER_ID'),
    providerNpi: str('STEDI_PROVIDER_NPI'),
    providerName: str('STEDI_PROVIDER_NAME'),
    serviceType: str('STEDI_SERVICE_TYPE', '30'),
    /**
     * A FHIR Coverage carries payer and member id but not the subscriber name
     * and date of birth a complete 270 needs. These fill the gap for test and
     * demo payers. In production they must come from the Coverage/RelatedPerson
     * record, never from process configuration.
     */
    subscriber: {
      firstName: str('STEDI_SUB_FIRST_NAME'),
      lastName: str('STEDI_SUB_LAST_NAME'),
      dob: str('STEDI_SUB_DOB'),
      memberId: str('STEDI_SUB_MEMBER_ID'),
    },
  },

  seed: {
    patientId: str('SEED_PATIENT_ID'),
    conditionId: str('SEED_CONDITION_ID'),
    questionnaireId: str('SEED_QUESTIONNAIRE_ID'),
  },
} as const;

/**
 * Every integration has a live path and a labelled mock path. These flags are
 * the single place that decides which one runs, so telemetry can always say
 * whether a result came from a real external system.
 *
 * Read them through `isLive()`, not directly: `goOffline()` has to be able to
 * force every integration to its mock at once.
 */
export const live = {
  medplum: Boolean(env.medplum.clientId && env.medplum.clientSecret),
  twilio: Boolean(env.twilio.accountSid && env.twilio.authToken && env.twilio.phoneNumber),
  deepgram: Boolean(env.deepgram.apiKey),
  moss: Boolean(env.moss.projectId && env.moss.projectKey),
  stedi: Boolean(env.stedi.apiKey && env.stedi.payerId && env.stedi.providerNpi),
  llm:
    (env.llm.provider === 'groq' && Boolean(env.llm.groqApiKey)) ||
    (env.llm.provider === 'anthropic' && Boolean(env.llm.anthropicApiKey)),
} as const;

/**
 * Global offline switch.
 *
 * `npm run simulate` is documented as a complete pipeline with zero
 * credentials. Left to the per-integration flags it silently used whatever
 * happened to be configured — writing fixture patients to a real FHIR server
 * and spending real Stedi and LLM calls on a synthetic scenario. The
 * simulation opts out of every live path explicitly, rather than depending on
 * whoever runs it having an empty `.env`.
 */
let offline = false;

export function goOffline(): void {
  offline = true;
}

export function isOffline(): boolean {
  return offline;
}

export function isLive(integration: keyof typeof live): boolean {
  return !offline && live[integration];
}

export function publicBaseUrl(): string {
  return env.publicHost ? `https://${env.publicHost}` : `http://localhost:${env.port}`;
}

export function publicWsUrl(path: string): string {
  return env.publicHost
    ? `wss://${env.publicHost}${path}`
    : `ws://localhost:${env.port}${path}`;
}
