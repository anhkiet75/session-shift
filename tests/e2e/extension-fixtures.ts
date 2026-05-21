import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startMockCookieServer } from './mock-cookie-server'

const EXTENSION_PATH = path.resolve(fileURLToPath(new URL('../..', import.meta.url)), 'dist')

export type ExtensionFixtures = {
  context: BrowserContext
  extensionId: string
  mockServerUrl: string
  popupUrl: string
  optionsUrl: string
  /** Popup page with chrome.tabs.query mocked so popup.ts initializes fully */
  popupPage: Page
}

export const test = base.extend<ExtensionFixtures>({
  // Each test gets a fresh persistent context with its own temp profile dir.
  // Using '' (CWD) causes parallel workers to collide on the same Chrome profile.
  context: async ({}, use, testInfo) => {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `pw-ext-${testInfo.workerIndex}-`),
    )
    const ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    })
    await use(ctx)
    await ctx.close()
    fs.rmSync(userDataDir, { recursive: true, force: true })
  },

  // Resolve extension ID from the service worker URL
  extensionId: async ({ context }, use) => {
    let [bg] = context.serviceWorkers()
    if (!bg) bg = await context.waitForEvent('serviceworker')
    const id = bg.url().split('/')[2]
    await use(id)
  },

  // Start local mock cookie server on a random port; tear it down after each test
  mockServerUrl: async ({}, use) => {
    const { server, url } = startMockCookieServer()
    await use(url)
    await new Promise<void>(resolve => server.close(() => resolve()))
  },

  // Convenience URLs
  popupUrl: async ({ extensionId }, use) => {
    await use(`chrome-extension://${extensionId}/popup/popup.html`)
  },

  optionsUrl: async ({ extensionId }, use) => {
    await use(`chrome-extension://${extensionId}/options/options.html`)
  },

  /**
   * A popup page with chrome.tabs.query mocked to return a real-looking tab.
   *
   * popup.ts early-returns with "Cannot isolate this page" when the active tab
   * URL is chrome-extension://. This fixture injects an init script that shadows
   * chrome.tabs.query before the popup script runs, so the popup initializes
   * fully with all event listeners attached.
   */
  popupPage: async ({ context, popupUrl, mockServerUrl }, use) => {
    const page = await context.newPage()

    // Inject before any page script runs — shadow chrome.tabs.query
    await page.addInitScript(({ fakeUrl }: { fakeUrl: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cr = (window as any).chrome

      // 1. Mock chrome.tabs.query — popup early-returns for chrome-extension:// URLs.
      //    Return a fake real page so the popup initializes fully.
      const originalQuery = cr.tabs.query.bind(cr.tabs)
      cr.tabs.query = async function (queryInfo: { active?: boolean; currentWindow?: boolean }) {
        if (queryInfo?.active && queryInfo?.currentWindow) {
          return [{ id: 1, url: fakeUrl, windowId: 1, active: true, index: 0,
                    highlighted: true, pinned: false, discarded: false,
                    autoDiscardable: true, groupId: -1, incognito: false }]
        }
        return originalQuery(queryInfo)
      }

      // 2. After creating a session the popup calls window.close().
      //    Override to reload instead — init script re-runs on reload so mock persists.
      window.close = () => window.location.reload()

      // 3. Suppress createSessionTab — prevents a background tab from opening during tests.
      const originalSendMessage = cr.runtime.sendMessage.bind(cr.runtime)
      cr.runtime.sendMessage = async (message: { action?: string }) => {
        if (message?.action === 'createSessionTab') return
        return originalSendMessage(message)
      }
    }, { fakeUrl: `${mockServerUrl}/cookies` })

    await page.goto(popupUrl)
    await page.waitForSelector('#btnNewSession', { state: 'visible', timeout: 15_000 })
    await use(page)
    await page.close()
  },
})

export { expect } from '@playwright/test'
