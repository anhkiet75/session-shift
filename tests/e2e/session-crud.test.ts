import { test, expect } from './extension-fixtures'

/** Create a named session and wait for the popup to reload and show its card. */
async function createSession(page: import('@playwright/test').Page, name: string) {
  await page.fill('#newSessionName', name)
  // Clicking Create calls window.close() which our init script overrides to reload.
  // Wait for the reload load event, then wait for popup to reinitialize.
  await Promise.all([
    page.waitForLoadState('load'),
    page.click('#btnNewSession'),
  ])
  await page.waitForSelector('#btnNewSession', { state: 'visible', timeout: 10_000 })
  await expect(page.locator('.v2-card-name', { hasText: name })).toBeVisible({ timeout: 10_000 })
}

async function seedSession(page: import('@playwright/test').Page, name: string, extraNames: string[] = []) {
  await page.evaluate(async (profileName) => {
    const names = [profileName.name, ...profileName.extraNames]
    await chrome.storage.local.set({
      profiles: names.map((name, index) => ({
        id: `session_${name.toLowerCase()}`,
        name,
        hue: index === 0 ? 212 : 30,
      })),
    })
  }, { name, extraNames })
  await page.reload()
  await page.waitForSelector('#btnNewSession', { state: 'visible', timeout: 10_000 })
  await expect(page.locator('.v2-card-name', { hasText: name })).toBeVisible({ timeout: 10_000 })
}

test.describe('Session CRUD', () => {
  test('create a session via popup', async ({ popupPage }) => {
    await createSession(popupPage, 'Work')
    await expect(popupPage.locator('.v2-card-name', { hasText: 'Work' })).toBeVisible()
  })

  test('create multiple sessions — all appear in list', async ({ popupPage }) => {
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      await createSession(popupPage, name)
    }
    await expect(popupPage.locator('.v2-card')).toHaveCount(3)
  })

  test('switch session makes it active', async ({ context, popupUrl, mockServerUrl }) => {
    const fakeUrl = `${mockServerUrl}/cookies`

    // Open a REAL http tab so the background's setSession validation (which calls
    // chrome.tabs.get(tabId) and checks the URL origin against the session list)
    // resolves against an actual existing tab.
    const realTab = await context.newPage()
    await realTab.goto(fakeUrl)

    // Use a throwaway extension page to query the real tab id via chrome.tabs API.
    const probe = await context.newPage()
    await probe.goto(popupUrl)
    const realTabId = await probe.evaluate(async (url: string) => {
      const cr = (window as unknown as { chrome: typeof chrome }).chrome
      const tabs = await cr.tabs.query({})
      return tabs.find(t => t.url === url)?.id ?? null
    }, fakeUrl)
    await probe.close()
    if (typeof realTabId !== 'number') throw new Error('Could not resolve real tab id')

    // Now open the popup page with mocks pinned to the real tab id.
    const page = await context.newPage()
    await page.addInitScript(({ tabId, url }: { tabId: number; url: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cr = (window as any).chrome
      const orig = cr.tabs.query.bind(cr.tabs)
      cr.tabs.query = async (q: { active?: boolean; currentWindow?: boolean }) =>
        q?.active && q?.currentWindow
          ? [{ id: tabId, url, windowId: 1, active: true, index: 0, highlighted: true, pinned: false, discarded: false, autoDiscardable: true, groupId: -1, incognito: false }]
          : orig(q)
      window.close = () => window.location.reload()
      const origSend = cr.runtime.sendMessage.bind(cr.runtime)
      Object.defineProperty(cr.runtime, 'sendMessage', {
        configurable: true,
        value: async (msg: { action?: string }) =>
          msg?.action === 'createSessionTab' ? undefined : origSend(msg),
      })
    }, { tabId: realTabId, url: fakeUrl })
    await page.goto(popupUrl)
    await page.waitForSelector('#btnNewSession', { state: 'visible' })

    await createSession(page, 'First')
    await createSession(page, 'Second')

    // Click the First card — switchToSession awaits setSession then calls
    // window.close() which our initScript overrides to window.location.reload()
    await Promise.all([
      page.waitForLoadState('load'),
      page.locator('.v2-card', { hasText: 'First' }).click(),
    ])
    await page.waitForSelector('#btnNewSession', { state: 'visible' })

    await expect(page.locator('.v2-card.active .v2-card-name')).toContainText('First')
    await page.close()
    await realTab.close()
  })

  test('delete session removes it from list', async ({ popupPage }) => {
    await seedSession(popupPage, 'ToDelete', ['Keep'])

    // Delete now uses an inline confirm UI — stable `data-action` selectors (not
    // English aria-label text) locate the controls; the card is still scoped by
    // its current (English-seeded) name.
    const toDeleteCard = popupPage.locator('.v2-card', { hasText: 'ToDelete' })
    await toDeleteCard.hover()
    // Separate localized-semantics check: the delete control's aria-label still
    // names the profile, independent of the stable data-action used to click it.
    await expect(toDeleteCard.locator('[data-action="delete-profile"]')).toHaveAttribute('aria-label', 'Delete profile ToDelete')
    await toDeleteCard.locator('[data-action="delete-profile"]').click()
    await toDeleteCard.locator('[data-action="confirm-delete"]').click()

    await expect(popupPage.locator('.v2-card-name', { hasText: 'ToDelete' })).not.toBeVisible()
  })

  test('duplicate session creates a copy', async ({ popupPage }) => {
    await seedSession(popupPage, 'Original')
    const countBefore = await popupPage.locator('.v2-card').count()

    const originalCard = popupPage.locator('.v2-card', { hasText: 'Original' })
    await originalCard.hover()
    await expect(originalCard.locator('[data-action="duplicate-profile"]')).toHaveAttribute('aria-label', 'Duplicate profile Original')
    await originalCard.locator('[data-action="duplicate-profile"]').click()
    await expect(popupPage.locator('.v2-card')).toHaveCount(countBefore + 1)
  })
})
