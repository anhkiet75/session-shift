import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    globals: false,
  },
})
