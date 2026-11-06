/**
 * Import this first in a CLI script to keep structured logs out of the
 * human-readable output. Set LOG_LEVEL explicitly to override.
 *
 * Import order matters: `logger.ts` reads the level once at module load, so
 * this must be evaluated before anything that imports the logger.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
export {};
