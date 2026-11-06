import pino from 'pino';
import { env } from './config/env.js';

/**
 * Member IDs, dates of birth and subscriber names must never reach the log
 * stream in full. Redaction is enforced here rather than at each call site.
 */
export const logger = pino({
  level: env.logLevel,
  redact: {
    paths: [
      'memberId',
      'subscriber',
      'subscriber.*',
      'coverage.memberId',
      'coverage.subscriber',
      'coverage.subscriber.*',
      'patient.birthDate',
      'patient.phone',
      '*.memberId',
      '*.authToken',
      '*.apiKey',
      '*.clientSecret',
    ],
    censor: '[redacted]',
  },
});

export function maskId(value: string | undefined): string {
  if (!value) return '(none)';
  return value.length <= 4 ? '****' : `****${value.slice(-4)}`;
}
