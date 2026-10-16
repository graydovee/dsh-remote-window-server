import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The end-to-end fixtures spawn real child processes and talk over pipes.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
