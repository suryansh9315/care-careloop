import type { Communication } from '@medplum/fhirtypes';
import { bestEffortCreate, searchResources, updateResource } from './medplum.js';
import { logger } from '../logger.js';

/**
 * The call log.
 *
 * There is no separate datastore, so a call is recorded as a Communication in
 * the `careloop-call` category, keyed on the Twilio callSid so the same call is
 * updated rather than duplicated as its status changes.
 *
 * Every write is best-effort: losing a log line must never affect a call in
 * progress.
 */

export const CALL_CATEGORY = 'careloop-call';
const CALL_SID_SYSTEM = 'https://careloop.dev/twilio-call-sid';

export type CallLogStatus =
  | 'initiated'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'busy'
  | 'no-answer'
  | 'canceled';

export interface CallLogEntry {
  callId: string;
  callSid: string;
  patientId: string;
  status: CallLogStatus;
  direction?: 'outbound' | 'inbound';
  moduleId?: string;
  /** Set once the questionnaire is submitted. */
  answered?: number;
  mock?: boolean;
}

function summarise(entry: CallLogEntry): string {
  return [
    `${entry.direction ?? 'outbound'} call`,
    `status=${entry.status}`,
    entry.moduleId ? `module=${entry.moduleId}` : '',
    entry.answered !== undefined ? `answers=${entry.answered}` : '',
    entry.mock ? '(mock)' : '',
    `sid=${entry.callSid}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

async function findBySid(callSid: string): Promise<Communication | undefined> {
  const results = await searchResources<Communication>('Communication', {
    identifier: `${CALL_SID_SYSTEM}|${callSid}`,
    _count: '1',
  });
  return results[0];
}

/**
 * Upsert on the callSid. Twilio delivers several status callbacks per call and
 * they can arrive out of order, so this must be idempotent.
 */
export async function recordCall(entry: CallLogEntry): Promise<void> {
  try {
    const existing = await findBySid(entry.callSid);
    const payload = summarise(entry);

    if (existing?.id) {
      await updateResource<Communication>({
        ...existing,
        status: entry.status === 'in-progress' ? 'in-progress' : 'completed',
        payload: [{ contentString: payload }],
      });
      return;
    }

    await bestEffortCreate<Communication>(
      {
        resourceType: 'Communication',
        status: entry.status === 'in-progress' ? 'in-progress' : 'completed',
        subject: { reference: `Patient/${entry.patientId}` },
        category: [{ text: CALL_CATEGORY }],
        identifier: [{ system: CALL_SID_SYSTEM, value: entry.callSid }],
        sent: new Date().toISOString(),
        payload: [{ contentString: payload }],
      },
      { callId: entry.callId },
    );
  } catch (error) {
    logger.warn({ callId: entry.callId, err: String(error) }, 'calllog.write.failed');
  }
}
