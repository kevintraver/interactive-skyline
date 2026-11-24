// Vitest: pure code (plan 01, section 8.1). Kept apart from Vite's build, which needs no configuration.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    // micro-benchmarks: Vitest runs these in a project of their own (`pnpm bench`)
    benchmark: { include: ['tests/bench/**/*.bench.js'] },
    environment: 'node',
    // a few tests do seconds of arithmetic or start Python, and every file runs at once: with other work on the
    // machine they passed alone and ran out of the default 5 s together
    testTimeout: 30_000,
  },
});
