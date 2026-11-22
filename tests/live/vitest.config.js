// The live contract test (plan 01, T5.6): real services, run daily by .github/workflows/live.yml and by hand with
// `pnpm test:live`. Not part of `pnpm test`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/live/**/*.test.js'], environment: 'node', testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false },
});
