import { test, expect } from './extension-fixtures'

async function seedSessions(page: import('@playwright/test').Page, names: string[]) {
  await page.evaluate(async (profileNames) => {
    await chrome.storage.local.set({
      profiles: profileNames.map((name, index) => ({
        id: `session_global_${index}`,
        name,
        hue: 212,
      })),
    })
  }, names)
  await page.reload()
  await page.waitForSelector('#btnNewSession', { state: 'visible', timeout: 10_000 })
}

test.describe('Global session list', () => {
  test('shows all profiles in the global list', async ({ popupPage }) => {
    await seedSessions(popupPage, ['GlobalAlpha', 'GlobalBeta'])
    await popupPage.waitForSelector('.v2-card', { timeout: 5_000 })

    await expect(popupPage.locator('.v2-card-name', { hasText: 'GlobalAlpha' })).toBeVisible()
    await expect(popupPage.locator('.v2-card-name', { hasText: 'GlobalBeta' })).toBeVisible()
  })

  test('search filters the global session list', async ({ popupPage }) => {
    await seedSessions(popupPage, ['FilterVisible', 'FilterHidden'])
    await popupPage.waitForSelector('.v2-card', { timeout: 5_000 })

    await popupPage.fill('#searchInput', 'FilterVisible')

    await expect(popupPage.locator('.v2-card-name', { hasText: 'FilterVisible' })).toBeVisible()
    await expect(popupPage.locator('.v2-card-name', { hasText: 'FilterHidden' })).not.toBeVisible()
  })

  test('search is available for the global profile list', async ({ popupPage }) => {
    await expect(popupPage.locator('#searchWrap')).toBeVisible()
  })
})
