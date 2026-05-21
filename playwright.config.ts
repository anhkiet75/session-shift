/// <reference types="node" />
import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const EXTENSION_PATH = path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'dist')

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  workers: process.env.CI ? 2 : 5,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    // Chrome extensions require headless:false — in CI use `xvfb-run -a npx playwright test`
    headless: false,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // Allow assertions to wait up to 10s for async storage/render cycles
  expect: { timeout: 10_000 },
  outputDir: 'test-results/',
  projects: [
    {
      name: 'chromium-extension',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
          ],
        },
      },
    },
  ],
})
