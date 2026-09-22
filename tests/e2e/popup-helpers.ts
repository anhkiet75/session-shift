// popup-helpers.ts — Shared popup-driving helpers for extension E2E suites.
//
// Not a test file: Playwright refuses test-file-to-test-file imports, so
// anything two suites both need lives here.

import type { BrowserContext, Page } from '@playwright/test'

/** Resolves a real Chrome tab id by a distinguishing fragment of its URL. */
export async function getTabIdByUrl(page: Page, urlPart: string): Promise<number> {
  const tabId = await page.evaluate(async (part) => {
    const tabs = await chrome.tabs.query({})
    return tabs.find((tab) => tab.url?.includes(part))?.id ?? null
  }, urlPart)
  if (typeof tabId !== 'number') throw new Error(`Could not resolve tab id for ${urlPart}`)
  return tabId
}

/**
 * Opens the popup with `chrome.tabs.query` mocked so it initializes against
 * `tabId`/`tabUrl` instead of its own `chrome-extension://` page.
 *
 * `readySelector` must exist in whichever popup state that tab produces:
 * `#btnNewSession` lives in the create-row, which the popup hides on
 * non-http(s) tabs, so those callers pass a selector present in both states
 * (`#favoritesSection`).
 */
export async function openPopupForTab(
  context: BrowserContext,
  popupUrl: string,
  tabId: number,
  tabUrl: string,
  readySelector = '#btnNewSession',
): Promise<Page> {
  const page = await context.newPage()
  await page.addInitScript(({ id, url }: { id: number; url: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cr = (window as any).chrome
    const originalQuery = cr.tabs.query.bind(cr.tabs)
    cr.tabs.query = async (queryInfo: { active?: boolean; currentWindow?: boolean }) =>
      queryInfo?.active && queryInfo?.currentWindow
        ? [{ id, url, windowId: 1, active: true, index: 0, highlighted: true, pinned: false, discarded: false, autoDiscardable: true, groupId: -1, incognito: false }]
        : originalQuery(queryInfo)
    // The popup closes itself after acting; reload instead so assertions can
    // continue against a freshly initialized popup.
    window.close = () => window.location.reload()
  }, { id: tabId, url: tabUrl })
  await page.goto(popupUrl)
  await page.waitForSelector(readySelector, { state: 'visible', timeout: 15_000 })
  return page
}

/** Polls the context for the tab the extension opened at `openedUrl`. */
export async function waitForOpenedPage(
  context: BrowserContext,
  openedUrl: string,
  excludedPages: Page[],
): Promise<Page> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const page = context.pages().find((candidate) =>
      !excludedPages.includes(candidate) && candidate.url() === openedUrl,
    )
    if (page) return page
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Could not find opened page for ${openedUrl}`)
}
