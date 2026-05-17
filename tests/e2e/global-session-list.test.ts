import { test, expect } from './extension-fixtures'

/** Creates a session via popup UI and waits for its card to appear. */
async function createSession(page: import('@playwright/test').Page, name: string) {
  await page.fill('#newSessionName', name)
  await Promise.all([
    page.waitForLoadState('load'),
    page.click('#btnNewSession'),
  ])
  await page.waitForSelector('#btnNewSession', { state: 'visible', timeout: 10_000 })
  await expect(page.locator('.v2-card-name', { hasText: name })).toBeVisible({ timeout: 10_000 })
}

test.describe('Global session list', () => {
  test('shows all sessions across origins in global view', async ({ popupPage }) => {
    await createSession(popupPage, 'GlobalAlpha')
    await createSession(popupPage, 'GlobalBeta')

    await popupPage.click('#tabGlobal')
    await popupPage.waitForSelector('.v2-card', { timeout: 5_000 })

    await expect(popupPage.locator('.v2-card-name', { hasText: 'GlobalAlpha' })).toBeVisible()
    await expect(popupPage.locator('.v2-card-name', { hasText: 'GlobalBeta' })).toBeVisible()
  })

  test('search filters the global session list', async ({ popupPage }) => {
    await createSession(popupPage, 'FilterVisible')
    await createSession(popupPage, 'FilterHidden')

    await popupPage.click('#tabGlobal')
    await popupPage.waitForSelector('.v2-card', { timeout: 5_000 })

    // Type into the search box that appears in global mode
    await popupPage.fill('#searchInput', 'FilterVisible')

    await expect(popupPage.locator('.v2-card-name', { hasText: 'FilterVisible' })).toBeVisible()
    await expect(popupPage.locator('.v2-card-name', { hasText: 'FilterHidden' })).not.toBeVisible()
  })

  test('switching tabs shows/hides search wrap correctly', async ({ popupPage }) => {
    // Search is hidden in origin mode (default)
    await expect(popupPage.locator('#searchWrap')).toBeHidden()

    await popupPage.click('#tabGlobal')
    // Search wrap appears in global mode
    await expect(popupPage.locator('#searchWrap')).toBeVisible()

    await popupPage.click('#tabOrigin')
    // Search wrap hides again in origin mode
    await expect(popupPage.locator('#searchWrap')).toBeHidden()
  })
})
