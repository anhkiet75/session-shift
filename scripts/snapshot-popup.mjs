import { chromium } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const EXTENSION_PATH = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'dist')
const OUT_PATH = process.argv[2] ?? path.resolve(process.cwd(), 'popup-snapshot.png')
const PROFILES = ['Developer', 'Marketing', 'Client']
const ACTIVE_PROFILE = 'Developer'
const THEME = process.argv[3] ?? 'dark'

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-snapshot-'))
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
  ],
})

let [bg] = ctx.serviceWorkers()
if (!bg) bg = await ctx.waitForEvent('serviceworker')
const extensionId = bg.url().split('/')[2]

// Set theme directly via the service worker so the popup opens already styled.
await bg.evaluate((theme) => chrome.storage.local.set({ ext_settings: { theme } }), THEME)

const page = await ctx.newPage()
await page.addInitScript(({ fakeUrl }) => {
  const cr = window.chrome
  const originalQuery = cr.tabs.query.bind(cr.tabs)
  cr.tabs.query = async function (queryInfo) {
    if (queryInfo?.active && queryInfo?.currentWindow) {
      return [{ id: 1, url: fakeUrl, windowId: 1, active: true, index: 0,
                highlighted: true, pinned: false, discarded: false,
                autoDiscardable: true, groupId: -1, incognito: false }]
    }
    return originalQuery(queryInfo)
  }
  // tabs.reload(1) targets a tab id that doesn't exist in this throwaway profile; no-op it.
  cr.tabs.reload = async () => {}
  // popup.ts calls window.close() after switching sessions — reload instead so state persists.
  window.close = () => window.location.reload()
}, { fakeUrl: 'https://example.com/' })

await page.goto(`chrome-extension://${extensionId}/popup/popup.html`)
await page.waitForSelector('#btnNewSession', { state: 'visible', timeout: 15_000 })

for (const name of PROFILES) {
  await page.fill('#newSessionName', name)
  await page.click('#btnNewSession')
  await page.waitForSelector(`.v2-card-name:text-is("${name}")`, { timeout: 5_000 })
}

await page.click(`.v2-card:has-text("${ACTIVE_PROFILE}")`)
await page.waitForLoadState('domcontentloaded')
await page.waitForSelector('.v2-card.active', { timeout: 5_000 })
await page.waitForTimeout(300)

await page.locator('.v2-popup').screenshot({ path: OUT_PATH })

await ctx.close()
fs.rmSync(userDataDir, { recursive: true, force: true })
console.log(`Saved: ${OUT_PATH}`)
