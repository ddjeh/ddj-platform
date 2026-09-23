import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    // Fail the run if no test files are found. Without this, a broken include
    // pattern reports success while testing nothing.
    passWithNoTests: false,
  },
});
