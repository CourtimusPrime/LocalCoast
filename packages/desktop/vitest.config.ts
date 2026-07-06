import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Unit tests never launch Electron; the smoke suite (scripts/smoke.mjs) does.
    passWithNoTests: true,
  },
});
