import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Tests exercise the deterministic core and the mock fallbacks; they must
    // never reach a real external system. Any test that touches an integration
    // imports `./test-offline.js` first — a `setupFiles` entry here is not used
    // because the dashboard package resolves this config too, and a root-
    // relative setup path fails to load from there.
    env: { LOG_LEVEL: 'silent' },
  },
});
