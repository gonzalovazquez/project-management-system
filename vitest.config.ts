import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // reserved/ holds Phase 3b code parked outside the build (see reserved/phase-3b-metrics/README.md);
    // its test doesn't compile against the current tree on purpose, so it's excluded here too.
    exclude: ['node_modules/**', 'reserved/**'],
  },
});
