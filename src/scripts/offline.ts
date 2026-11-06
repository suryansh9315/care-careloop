/**
 * Import this FIRST in a script that must not touch any external system.
 *
 * Import order matters: `config/env.ts` and `logger.ts` read their settings
 * once at module load, so this has to be evaluated before anything that pulls
 * them in.
 *
 * `npm run simulate` is documented as a complete pipeline with zero
 * credentials. Without this it quietly used whatever happened to be in `.env` —
 * writing fixture patients to a real FHIR server (leaving CarePlans pointing at
 * `Patient/sim-patient-asthma`, which does not exist) and spending real Stedi
 * and LLM calls on a synthetic scenario.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const { goOffline } = await import('../config/env.js');
goOffline();

export {};
