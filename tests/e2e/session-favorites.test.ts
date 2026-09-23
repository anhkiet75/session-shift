import { test, expect } from './extension-fixtures'
import type { BrowserContext, Page } from '@playwright/test'
import { getTabIdByUrl, openPopupForTab, waitForOpenedPage } from './popup-helpers'

const PROFILE_A = 'session_fav_a_e2e'
const PROFILE_B = 'session_fav_b_e2e'

interface SeedFavorite { id: string; label: string; url: string; sessionId: string }

async function seed(
  page: Page,
  profiles: { id: string; name: string; hue: number }[],
  favorites: SeedFavorite[],
): Promise<void> {
  await page.evaluate(async ({ profiles, favorites }) => {
    const stores: Record<string, unknown> = {}
    for (const profile of profiles) stores[`cookies_${profile.id}`] = {}
    await chrome.storage.local.set({
      profiles,
      favorites: favorites.map(f => ({ ...f, createdAt: Date.now() })),
      ...stores,
    })
  }, { profiles, favorites })
}

/** Waits until the background has captured `value` into some profile's cookie store. */
async function waitForCapture(helperPage: Page, value: string): Promise<void> {
  await helperPage.waitForFunction(
    async (expected) => {
      const all = await chrome.storage.local.get(null)
      return Object.entries(all).some(([key, store]) =>
        key.startsWith('cookies_') && store && typeof store === 'object' &&
        Object.values(store).some((entry) =>
          entry && typeof entry === 'object' && (entry as { value?: unknown }).value === expected),
      )
    },
    value,
    { timeout: 5_000 },
  )
  // The DNR rule for the captured host is installed just after the write lands.
  await helperPage.waitForTimeout(150)
}

/** Opens the popup for `tabId`, launches the named favorite, and returns the tab it opened. */
async function launchFavorite(
  context: BrowserContext,
  popupUrl: string,
  tabId: number,
  tabUrl: string,
  label: string,
  targetUrl: string,
  exclude: Page[],
): Promise<{ popup: Page; opened: Page }> {
  const popup = await openPopupForTab(context, popupUrl, tabId, tabUrl, '#favoritesSection')
  const row = popup.locator('.v2-fav-row', { hasText: label })
  await expect(row).toBeVisible()
  await row.locator('[data-action="launch-favorite"]').click()
  const opened = await waitForOpenedPage(context, targetUrl, [...exclude, popup])
  return { popup, opened }
}

function cookiesOf(body: string | null): Record<string, string> {
  return JSON.parse(body ?? '{}').cookies ?? {}
}

test.describe('Session favorites', () => {
  test('a favorite opens in its own profile jar — never the default one, never another profile\'s', async ({
    context, extensionId, popupUrl, mockServerUrl,
  }) => {
    const targetUrl = `${mockServerUrl}/cookies?source=favorite`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)

    const defaultTab = await context.newPage()
    await defaultTab.goto(`${mockServerUrl}/set?user=default`)
    await defaultTab.goto(targetUrl)
    expect(cookiesOf(await defaultTab.textContent('body')).user).toBe('default')
    const defaultTabId = await getTabIdByUrl(helperPage, 'source=favorite')

    // The same URL saved twice, bound to two different profiles.
    await seed(
      helperPage,
      [{ id: PROFILE_A, name: 'Alpha', hue: 212 }, { id: PROFILE_B, name: 'Beta', hue: 24 }],
      [
        { id: 'fav_alpha', label: 'Alpha mail', url: targetUrl, sessionId: PROFILE_A },
        { id: 'fav_beta', label: 'Beta mail', url: targetUrl, sessionId: PROFILE_B },
      ],
    )

    // Alpha starts clean: the default jar's cookie must not ride along on the
    // very first load, which is what `stripCookiesOnNextNavigation` guarantees.
    const first = await launchFavorite(context, popupUrl, defaultTabId, targetUrl, 'Alpha mail', targetUrl, [defaultTab, helperPage])
    expect(cookiesOf(await first.opened.textContent('body')).user).toBeUndefined()

    await first.opened.goto(`${mockServerUrl}/set?user=alpha`)
    await waitForCapture(helperPage, 'alpha')

    // Beta must not see Alpha's cookie either.
    await defaultTab.bringToFront()
    const second = await launchFavorite(context, popupUrl, defaultTabId, targetUrl, 'Beta mail', targetUrl,
      [defaultTab, helperPage, first.popup, first.opened])
    expect(cookiesOf(await second.opened.textContent('body')).user).toBeUndefined()

    await second.opened.goto(`${mockServerUrl}/set?user=beta`)
    await waitForCapture(helperPage, 'beta')

    // Re-launching each favorite lands in its own jar — the whole point of the feature.
    await defaultTab.bringToFront()
    const alphaAgain = await launchFavorite(context, popupUrl, defaultTabId, targetUrl, 'Alpha mail', targetUrl,
      [defaultTab, helperPage, first.popup, first.opened, second.popup, second.opened])
    expect(cookiesOf(await alphaAgain.opened.textContent('body')).user).toBe('alpha')

    await defaultTab.bringToFront()
    const betaAgain = await launchFavorite(context, popupUrl, defaultTabId, targetUrl, 'Beta mail', targetUrl,
      [defaultTab, helperPage, first.popup, first.opened, second.popup, second.opened, alphaAgain.popup, alphaAgain.opened])
    expect(cookiesOf(await betaAgain.opened.textContent('body')).user).toBe('beta')

    // NOTE: whether the browser's own global jar stays free of an isolated
    // tab's Set-Cookie is a property of the shared `createSessionTab` path, not
    // of favorites — it behaves identically for the right-click "Open in new
    // tab" flow. Deliberately not asserted here.

    await helperPage.close()
  })

  test('favorites render and launch from a page that cannot be isolated', async ({
    context, extensionId, popupUrl, mockServerUrl,
  }) => {
    const targetUrl = `${mockServerUrl}/cookies?source=non-http`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)

    const anchorTab = await context.newPage()
    await anchorTab.goto(targetUrl)
    const anchorTabId = await getTabIdByUrl(helperPage, 'source=non-http')

    await seed(helperPage, [{ id: PROFILE_A, name: 'Alpha', hue: 212 }],
      [{ id: 'fav_alpha', label: 'Alpha mail', url: targetUrl, sessionId: PROFILE_A }])

    // The popup is told the active tab is a chrome:// page — the state that
    // used to replace the entire popup with the "cannot isolate" notice.
    const popup = await openPopupForTab(context, popupUrl, anchorTabId, 'chrome://newtab/', '#favoritesSection')

    // Notice still shown, but now scoped to the profile area…
    await expect(popup.locator('#savedSessionsList')).toContainText('Cannot isolate this page.')
    await expect(popup.locator('#createRow')).toBeHidden()
    // …and the star is disabled rather than absent.
    await expect(popup.locator('#saveFavorite')).toBeDisabled()

    // …while favorites remain fully usable, which is the point of the restructure.
    const row = popup.locator('.v2-fav-row', { hasText: 'Alpha mail' })
    await expect(row).toBeVisible()
    await row.locator('[data-action="launch-favorite"]').click()
    const opened = await waitForOpenedPage(context, targetUrl, [anchorTab, helperPage, popup])
    expect(cookiesOf(await opened.textContent('body')).user).toBeUndefined()

    await helperPage.close()
  })

  test('deleting a profile removes its favorites and leaves other profiles\' alone', async ({
    context, extensionId, popupUrl, mockServerUrl,
  }) => {
    const targetUrl = `${mockServerUrl}/cookies?source=cascade`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)

    const tab = await context.newPage()
    await tab.goto(targetUrl)
    const tabId = await getTabIdByUrl(helperPage, 'source=cascade')

    await seed(
      helperPage,
      [{ id: PROFILE_A, name: 'Alpha', hue: 212 }, { id: PROFILE_B, name: 'Beta', hue: 24 }],
      [
        { id: 'fav_alpha', label: 'Alpha mail', url: targetUrl, sessionId: PROFILE_A },
        { id: 'fav_beta', label: 'Beta mail', url: targetUrl, sessionId: PROFILE_B },
      ],
    )

    const popup = await openPopupForTab(context, popupUrl, tabId, targetUrl)
    await expect(popup.locator('.v2-fav-row', { hasText: 'Alpha mail' })).toBeVisible()

    // Delete profile Alpha through the popup's own confirm flow.
    const alphaCard = popup.locator('.v2-card', { hasText: 'Alpha' })
    await alphaCard.locator('[data-action="delete-profile"]').click()
    await alphaCard.locator('[data-action="confirm-delete"]').click()
    await expect(alphaCard).toHaveCount(0)

    await expect.poll(async () => helperPage.evaluate(async () => {
      const { favorites } = await chrome.storage.local.get(['favorites'])
      return (favorites as { id: string }[]).map(f => f.id)
    })).toEqual(['fav_beta'])

    // Reopened popup shows only Beta's favorite.
    const popupAgain = await openPopupForTab(context, popupUrl, tabId, targetUrl)
    await expect(popupAgain.locator('.v2-fav-row', { hasText: 'Beta mail' })).toBeVisible()
    await expect(popupAgain.locator('.v2-fav-row', { hasText: 'Alpha mail' })).toHaveCount(0)

    await helperPage.close()
  })

  test('the hero star saves the current tab, and a second click removes it', async ({
    context, extensionId, popupUrl, mockServerUrl,
  }) => {
    const targetUrl = `${mockServerUrl}/cookies?source=star`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)

    const tab = await context.newPage()
    await tab.goto(targetUrl)
    const tabId = await getTabIdByUrl(helperPage, 'source=star')

    await seed(helperPage, [{ id: PROFILE_A, name: 'Alpha', hue: 212 }], [])

    // Bind the tab to a profile — the star is deliberately disabled while a tab
    // is still on the default profile.
    await helperPage.evaluate(async ({ tabId, sessionId }) => {
      await chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId } })
    }, { tabId, sessionId: PROFILE_A })

    const popup = await openPopupForTab(context, popupUrl, tabId, targetUrl)
    const star = popup.locator('#saveFavorite')
    await expect(star).toBeEnabled()
    await expect(star).toHaveAttribute('aria-pressed', 'false')
    // Nothing saved yet, so the section stays hidden.
    await expect(popup.locator('#favoritesSection')).toBeHidden()

    await star.click()
    await expect(star).toHaveAttribute('aria-pressed', 'true')
    await expect(popup.locator('.v2-fav-row')).toHaveCount(1)
    await expect.poll(async () => helperPage.evaluate(async () => {
      const { favorites } = await chrome.storage.local.get(['favorites'])
      return (favorites as { sessionId: string }[]).map(f => f.sessionId)
    })).toEqual([PROFILE_A])

    // Second click removes it and the section disappears again.
    await star.click()
    await expect(star).toHaveAttribute('aria-pressed', 'false')
    await expect(popup.locator('#favoritesSection')).toBeHidden()
    await expect.poll(async () => helperPage.evaluate(async () => {
      const { favorites } = await chrome.storage.local.get(['favorites'])
      return (favorites as unknown[]).length
    })).toBe(0)

    await helperPage.close()
  })

  test('the star is disabled on a default-profile tab', async ({
    context, extensionId, popupUrl, mockServerUrl,
  }) => {
    const targetUrl = `${mockServerUrl}/cookies?source=star-default`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)
    const tab = await context.newPage()
    await tab.goto(targetUrl)
    const tabId = await getTabIdByUrl(helperPage, 'source=star-default')
    await seed(helperPage, [{ id: PROFILE_A, name: 'Alpha', hue: 212 }], [])

    const popup = await openPopupForTab(context, popupUrl, tabId, targetUrl)
    // A default-bound favorite would switch nothing, and createSessionTab
    // rejects sessionId 'default' outright.
    await expect(popup.locator('#saveFavorite')).toBeDisabled()

    await helperPage.close()
  })

  test('removing a favorite from the popup asks for confirmation first', async ({
    context, extensionId, popupUrl, mockServerUrl,
  }) => {
    const targetUrl = `${mockServerUrl}/cookies?source=remove-confirm`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)
    const tab = await context.newPage()
    await tab.goto(targetUrl)
    const tabId = await getTabIdByUrl(helperPage, 'source=remove-confirm')

    await seed(helperPage, [{ id: PROFILE_A, name: 'Alpha', hue: 212 }],
      [{ id: 'fav_confirm', label: 'To remove', url: targetUrl, sessionId: PROFILE_A }])

    const popup = await openPopupForTab(context, popupUrl, tabId, targetUrl, '#favoritesSection')
    const row = popup.locator('.v2-fav-row', { hasText: 'To remove' })
    await row.locator('[data-action="remove-favorite"]').click()

    // Same interaction as a profile card's delete — nothing removed yet, the
    // row steps aside for cancel/confirm, and cancel backs out cleanly.
    await expect(row.locator('.v2-card-del-cancel')).toBeVisible()
    await expect(row.locator('.v2-card-del-confirm')).toBeVisible()
    await expect.poll(async () => helperPage.evaluate(async () => {
      const { favorites } = await chrome.storage.local.get(['favorites'])
      return (favorites as unknown[]).length
    })).toBe(1)

    await row.locator('.v2-card-del-cancel').click()
    await expect(popup.locator('.v2-fav-row', { hasText: 'To remove' })).toBeVisible()

    await popup.locator('.v2-fav-row', { hasText: 'To remove' })
      .locator('[data-action="remove-favorite"]').click()
    await popup.locator('.v2-card-del-confirm').click()
    await expect(popup.locator('#favoritesSection')).toBeHidden()
    await expect.poll(async () => helperPage.evaluate(async () => {
      const { favorites } = await chrome.storage.local.get(['favorites'])
      return (favorites as unknown[]).length
    })).toBe(0)

    await helperPage.close()
  })

  test('renaming a favorite inline from the popup saves on Enter or the check button and backs out on Escape', async ({
    context, extensionId, popupUrl, mockServerUrl,
  }) => {
    const targetUrl = `${mockServerUrl}/cookies?source=rename-inline`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)
    const tab = await context.newPage()
    await tab.goto(targetUrl)
    const tabId = await getTabIdByUrl(helperPage, 'source=rename-inline')

    await seed(helperPage, [{ id: PROFILE_A, name: 'Alpha', hue: 212 }],
      [{ id: 'fav_rename', label: 'Old name', url: targetUrl, sessionId: PROFILE_A }])

    const popup = await openPopupForTab(context, popupUrl, tabId, targetUrl, '#favoritesSection')
    const storedLabel = () => helperPage.evaluate(async () => {
      const { favorites } = await chrome.storage.local.get(['favorites'])
      return (favorites as { label: string }[])[0].label
    })

    // Escape discards the edit and restores the row untouched.
    await popup.locator('.v2-fav-row', { hasText: 'Old name' })
      .locator('[data-action="rename-favorite"]').click()
    const input = popup.locator('.v2-fav-row .v2-rename-input')
    await expect(input).toHaveValue('Old name')
    await input.fill('Discarded')
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(popup.locator('.v2-fav-label')).toHaveText('Old name')
    expect(await storedLabel()).toBe('Old name')

    // Enter saves to storage and the row re-renders with the new label.
    await popup.locator('[data-action="rename-favorite"]').click()
    await input.fill('  New   name ')
    await input.press('Enter')
    await expect(popup.locator('.v2-fav-label')).toHaveText('New name')
    await expect.poll(storedLabel).toBe('New name')

    // While editing, the pencil becomes a check that saves; the × is hidden.
    await popup.locator('[data-action="rename-favorite"]').click()
    await expect(popup.locator('[data-action="rename-favorite"].editing')).toBeVisible()
    await expect(popup.locator('[data-action="remove-favorite"]')).toBeHidden()
    await input.fill('Via check')
    await popup.locator('[data-action="rename-favorite"]').click()
    await expect(popup.locator('.v2-fav-label')).toHaveText('Via check')
    // Out of edit mode: the check is back to the pencil, the × is back.
    await expect(popup.locator('.v2-fav-row .v2-rename-input')).toHaveCount(0)
    await expect(popup.locator('[data-action="rename-favorite"].editing')).toHaveCount(0)
    await popup.locator('.v2-fav-row').hover()
    await expect(popup.locator('[data-action="remove-favorite"]')).toBeVisible()
    await expect(popup.locator('.v2-fav-row')).toHaveCount(1)
    await expect.poll(storedLabel).toBe('Via check')

    await helperPage.close()
  })

  test('a favorite orphaned out of band is disabled, not launched into the default jar', async ({
    context, extensionId, popupUrl, mockServerUrl,
  }) => {
    const targetUrl = `${mockServerUrl}/cookies?source=orphan`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)

    const tab = await context.newPage()
    await tab.goto(targetUrl)
    const tabId = await getTabIdByUrl(helperPage, 'source=orphan')

    // Favorite bound to a profile that is not in `profiles` — the state a
    // failed migration or an out-of-band storage edit leaves behind.
    await seed(helperPage, [{ id: PROFILE_B, name: 'Beta', hue: 24 }],
      [{ id: 'fav_orphan', label: 'Orphan mail', url: targetUrl, sessionId: 'session_gone_e2e' }])

    const popup = await openPopupForTab(context, popupUrl, tabId, targetUrl)
    const row = popup.locator('.v2-fav-row', { hasText: 'Orphan mail' })
    await expect(row).toHaveClass(/missing/)
    await expect(row.locator('[data-action="launch-favorite"]')).toBeDisabled()
    await expect(row.locator('.v2-fav-missing')).toBeVisible()
    // Remove stays available so a dead entry is never stuck in the list.
    await expect(row.locator('[data-action="remove-favorite"]')).toBeEnabled()

    await helperPage.close()
  })
})
