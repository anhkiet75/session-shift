import { test, expect } from './extension-fixtures'
import type { BrowserContext, Page } from '@playwright/test'

async function getTabIdByUrl(page: Page, urlPart: string): Promise<number> {
  const tabId = await page.evaluate(async (part) => {
    const tabs = await chrome.tabs.query({})
    return tabs.find((tab) => tab.url?.includes(part))?.id ?? null
  }, urlPart)
  if (typeof tabId !== 'number') throw new Error(`Could not resolve tab id for ${urlPart}`)
  return tabId
}

async function openPopupForTab(
  context: BrowserContext,
  popupUrl: string,
  tabId: number,
  tabUrl: string,
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
    window.close = () => window.location.reload()
  }, { id: tabId, url: tabUrl })
  await page.goto(popupUrl)
  await page.waitForSelector('#btnNewSession', { state: 'visible', timeout: 15_000 })
  return page
}

async function openProfileFromRightClick(page: Page, profileName: string): Promise<void> {
  await page.locator('.v2-card', { hasText: profileName }).click({ button: 'right' })
  await expect(page.locator('.v2-open-tab-menu-item', { hasText: 'Open in new tab' })).toBeVisible()
  await Promise.all([
    page.waitForLoadState('load'),
    page.locator('.v2-open-tab-menu-item', { hasText: 'Open in new tab' }).click(),
  ])
}

async function waitForOpenedPage(
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

test.describe('Profile right-click open in new tab', () => {
  test('opens current URL in the selected isolated profile without default-cookie leakage', async ({
    context, extensionId, popupUrl, mockServerUrl,
  }) => {
    const profileName = `OpenTab-${Date.now()}`
    const originUrl = `${mockServerUrl}/cookies?source=right-click`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)

    const defaultTab = await context.newPage()
    await defaultTab.goto(`${mockServerUrl}/set?user=default`)
    await defaultTab.goto(originUrl)
    expect(JSON.parse(await defaultTab.textContent('body') ?? '{}').cookies.user).toBe('default')
    const defaultTabId = await getTabIdByUrl(helperPage, 'source=right-click')

    await helperPage.evaluate(async ({ profileName }) => {
      await chrome.storage.local.set({
        profiles: [{ id: 'session_open_tab_e2e', name: profileName, hue: 212 }],
        cookies_session_open_tab_e2e: {},
      })
    }, { profileName })

    const popup = await openPopupForTab(context, popupUrl, defaultTabId, originUrl)
    await expect(popup.locator('.v2-card-name', { hasText: profileName })).toBeVisible()
    await popup.locator('.v2-card', { hasText: profileName }).focus()
    await popup.keyboard.press('Shift+F10')
    await expect(popup.locator('.v2-open-tab-menu-item', { hasText: 'Open in new tab' })).toBeVisible()
    await popup.keyboard.press('Escape')
    await expect(popup.locator('.v2-open-tab-menu-item', { hasText: 'Open in new tab' })).not.toBeVisible()

    await openProfileFromRightClick(popup, profileName)
    const firstProfileTab = await waitForOpenedPage(context, originUrl, [defaultTab, helperPage, popup])
    expect(JSON.parse(await firstProfileTab.textContent('body') ?? '{}').cookies.user).toBeUndefined()

    await firstProfileTab.goto(`${mockServerUrl}/set?user=isolated`)
    await helperPage.waitForFunction(
      async () => {
        const all = await chrome.storage.local.get(null)
        return Object.values(all).some((value) =>
          value && typeof value === 'object' && Object.values(value).some((entry) =>
            entry && typeof entry === 'object' && (entry as { value?: unknown }).value === 'isolated',
          ),
        )
      },
      undefined,
      { timeout: 5_000 },
    )
    await helperPage.waitForTimeout(150)

    await defaultTab.bringToFront()
    const popupAgain = await openPopupForTab(context, popupUrl, defaultTabId, originUrl)
    await openProfileFromRightClick(popupAgain, profileName)
    const secondProfileTab = await waitForOpenedPage(context, originUrl, [defaultTab, helperPage, popup, popupAgain, firstProfileTab])
    expect(JSON.parse(await secondProfileTab.textContent('body') ?? '{}').cookies.user).toBe('isolated')

    await helperPage.close()
  })
})
