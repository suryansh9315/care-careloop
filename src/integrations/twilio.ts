import twilio from 'twilio';
import { env, isLive, publicBaseUrl, publicWsUrl } from '../config/env.js';
import { logger } from '../logger.js';

let client: ReturnType<typeof twilio> | undefined;

function getClient(): ReturnType<typeof twilio> {
  if (!client) {
    client = twilio(env.twilio.accountSid, env.twilio.authToken);
  }
  return client;
}

export interface PlacedCall {
  callSid: string;
  mock: boolean;
}

export async function placeOutboundCall(to: string, callId: string): Promise<PlacedCall> {
  if (!isLive('twilio')) {
    logger.warn({ callId }, 'twilio.mock.call');
    return { callSid: `mock-call-${callId}`, mock: true };
  }
  /**
   * Answering-machine detection is OFF by default, and that is deliberate.
   *
   * With `machineDetection: 'Enable'`, Twilio withholds the TwiML request until
   * AMD finishes and drops the call outright on `machine_start`. A patient who
   * answers with a short "hello?" then pauses — exactly how people answer an
   * unknown number — is classified as a machine, and the check-in never
   * happens. Failing to reach someone who did answer is a worse outcome than
   * occasionally greeting a voicemail, so AMD is opt-in via TWILIO_AMD=true.
   */
  const amdEnabled = process.env.TWILIO_AMD === 'true';

  const call = await getClient().calls.create({
    to,
    from: env.twilio.phoneNumber,
    url: `${publicBaseUrl()}/voice?callId=${encodeURIComponent(callId)}`,
    statusCallback: `${publicBaseUrl()}/voice/status?callId=${encodeURIComponent(callId)}`,
    statusCallbackEvent: ['initiated', 'answered', 'completed'],
    ...(amdEnabled
      ? { machineDetection: 'DetectMessageEnd' as const, machineDetectionTimeout: 15 }
      : {}),
  });
  logger.info({ callId, callSid: call.sid }, 'twilio.call.placed');
  return { callSid: call.sid, mock: false };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * TwiML that hands the media stream straight to the bridge. `<Connect><Stream>`
 * is bidirectional, which is what lets the agent both hear and speak.
 *
 * Identifiers are passed as `<Parameter>` children, not as query string on the
 * URL. Twilio does not reliably carry a query string through to the media
 * stream socket — observed live as an upgrade arriving with an empty callId —
 * whereas `<Parameter>` values are delivered in the `start` frame as
 * `start.customParameters`. The query string is still appended as a hint for
 * proxy logs and for the fast path when it does survive.
 */
export function buildStreamTwiml(input: {
  callId: string;
  patientId?: string;
  conditionId?: string;
}): string {
  const { callId, patientId, conditionId } = input;
  const streamUrl = `${publicWsUrl('/twilio')}?callId=${encodeURIComponent(callId)}`;
  const parameters = [
    `<Parameter name="callId" value="${xmlEscape(callId)}" />`,
    patientId ? `<Parameter name="patientId" value="${xmlEscape(patientId)}" />` : '',
    conditionId ? `<Parameter name="conditionId" value="${xmlEscape(conditionId)}" />` : '',
  ]
    .filter(Boolean)
    .join('\n      ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(streamUrl)}">
      ${parameters}
    </Stream>
  </Connect>
</Response>`;
}

export function buildHangupTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${message}</Say>
  <Hangup/>
</Response>`;
}

export function validateTwilioSignature(
  signature: string | undefined,
  url: string,
  params: Record<string, unknown>,
): boolean {
  if (!isLive('twilio')) return true;
  if (!signature) return false;
  return twilio.validateRequest(env.twilio.authToken, signature, url, params as never);
}
