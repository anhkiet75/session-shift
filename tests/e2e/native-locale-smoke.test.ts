import { test, expect, chromium, type BrowserContext } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// Phase 6 release gate: Chrome-owned manifest/command surfaces (extensionName,
// extensionDescription, command descriptions) resolve via the native
// chrome.i18n API against Chrome's own UI locale (--lang launch flag), never
// via this extension's stored `ext_settings.language` manual override. This
// is a separate authority from the runtime adapter tested in
// localization-rtl.test.ts and needs its own browser launch per locale.

const EXTENSION_PATH = path.resolve(fileURLToPath(new URL('../..', import.meta.url)), 'dist')

interface LangContext {
  context: BrowserContext
  userDataDir: string
}

async function launchWithLang(lang: string): Promise<LangContext> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `pw-ext-lang-${lang}-`))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.PW_HEADLESS === '1',
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      `--lang=${lang}`,
    ],
  })
  return { context, userDataDir }
}

async function cleanup({ context, userDataDir }: LangContext): Promise<void> {
  await context.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
}

test.describe('Native locale (Chrome --lang) smoke — manifest/command authority', () => {
  test('extensionDescription resolves via native chrome.i18n under --lang=de, independent of any manual preference', async () => {
    const lc = await launchWithLang('de')
    try {
      let [bg] = lc.context.serviceWorkers()
      if (!bg) bg = await lc.context.waitForEvent('serviceworker')
      const extensionId = bg.url().split('/')[2]

      const page = await lc.context.newPage()
      await page.goto(`chrome-extension://${extensionId}/popup/popup.html`)

      // A manual preference set in storage must never leak into the
      // Chrome-owned chrome.i18n resolution used for manifest/command text.
      await page.evaluate(async () => {
        await chrome.storage.local.set({ ext_settings: { theme: 'system', language: 'vi' } })
      })

      const description = await page.evaluate(() => chrome.i18n.getMessage('extensionDescription'))
      expect(description).toBe(
        'Wechseln Sie auf jeder Website zwischen mehreren Konten — jeder Tab erhält seine eigene isolierte Sitzung.',
      )
      const commandDesc = await page.evaluate(() => chrome.i18n.getMessage('commandExecuteActionDescription'))
      expect(commandDesc).toBe('SessionShift-Popup öffnen')

      await page.close()
    } finally {
      await cleanup(lc)
    }
  })

  test('extensionDescription resolves via native chrome.i18n under --lang=ar (RTL script)', async () => {
    const lc = await launchWithLang('ar')
    try {
      let [bg] = lc.context.serviceWorkers()
      if (!bg) bg = await lc.context.waitForEvent('serviceworker')
      const extensionId = bg.url().split('/')[2]

      const page = await lc.context.newPage()
      await page.goto(`chrome-extension://${extensionId}/popup/popup.html`)

      const description = await page.evaluate(() => chrome.i18n.getMessage('extensionDescription'))
      expect(description).toBe(
        'بدّل بين عدة حسابات على أي موقع — يحصل كل تبويب على جلسة معزولة خاصة به.',
      )

      await page.close()
    } finally {
      await cleanup(lc)
    }
  })
})
