// Vitest: pure code (plan 01, section 8.1). Kept apart from Vite's build, which needs no configuration.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    benchmark: { include: ['tests/bench/**/*.bench.js'] },
    environment: 'node',
  },
});
