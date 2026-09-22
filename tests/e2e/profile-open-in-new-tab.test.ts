import { test, expect } from './extension-fixtures'
import type { Page } from '@playwright/test'
import { getTabIdByUrl, openPopupForTab, waitForOpenedPage } from './popup-helpers'

async function openProfileFromRightClick(page: Page, profileName: string): Promise<void> {
  await page.locator('.v2-card', { hasText: profileName }).click({ button: 'right' })
  // Stable `data-action` selector for interaction; the visibility/text check
  // below is the separate localized-semantics assertion.
  await expect(page.locator('[data-action="open-in-new-tab"]', { hasText: 'Open in new tab' })).toBeVisible()
  await Promise.all([
    page.waitForLoadState('load'),
    page.locator('[data-action="open-in-new-tab"]').click(),
  ])
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
    await expect(popup.locator('[data-action="open-in-new-tab"]', { hasText: 'Open in new tab' })).toBeVisible()
    await popup.keyboard.press('Escape')
    await expect(popup.locator('[data-action="open-in-new-tab"]', { hasText: 'Open in new tab' })).not.toBeVisible()

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
