import { test, expect, seedLocalePreference } from './extension-fixtures'

// Baseline surface-switching/completeness coverage for Phase 3 (English +
// System + one representative manual locale). RTL-specific mixed-direction
// and layout assertions are expanded in Phase 4.

test.describe('Options — language picker', () => {
  test('switching to German localizes Options immediately and persists across reload', async ({ context, optionsUrl }) => {
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.waitForSelector('#languageSelect')

    // Chrome-English baseline before any manual selection.
    await expect(options.locator('#tab-settings span')).toHaveText('Settings')

    await options.selectOption('#languageSelect', 'de')
    await expect(options.locator('#tab-settings span')).toHaveText('Einstellungen')
    await expect(options.locator('#tab-about span')).toHaveText('Über')
    await expect(options.locator('html')).toHaveAttribute('lang', 'de')

    await options.reload()
    await options.waitForSelector('#languageSelect')
    await expect(options.locator('#tab-settings span')).toHaveText('Einstellungen')
    await expect(options.locator('#languageSelect')).toHaveValue('de')

    await options.close()
  })

  test('language select lists System plus all 55 supported locales', async ({ context, optionsUrl }) => {
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.waitForSelector('#languageSelect')

    const optionCount = await options.locator('#languageSelect option').count()
    expect(optionCount).toBe(1 + 55) // System + 55 locale codes

    await options.close()
  })
})

test.describe('Popup — manual locale reflected on open', () => {
  test('popup opens already localized when a manual German preference is stored', async ({ popupPage }) => {
    await seedLocalePreference(popupPage, 'de')
    await popupPage.reload()
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })

    await expect(popupPage.locator('#btnNewSession span')).toHaveText('Erstellen')
    await expect(popupPage.locator('#searchInput')).toHaveAttribute('placeholder', 'Profile durchsuchen…')
    await expect(popupPage.locator('html')).toHaveAttribute('lang', 'de')
    expect(await popupPage.locator('.v2-popup').getAttribute('inert')).toBeNull()
  })

  test('existing mixed-script profile name and English default fallback are preserved under a manual locale', async ({ popupPage }) => {
    await popupPage.evaluate(async () => {
      await chrome.storage.local.set({
        profiles: [{ id: 'session_mixed', name: 'Work حساب', hue: 200 }],
      })
    })
    await seedLocalePreference(popupPage, 'ar')
    await popupPage.reload()
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })

    // Stored profile name is user data — never translated/rewritten.
    await expect(popupPage.locator('.v2-card-name', { hasText: 'Work حساب' })).toBeVisible()
    // UI chrome around it is localized.
    await expect(popupPage.locator('html')).toHaveAttribute('dir', 'rtl')
  })

  test('reveals accessibly with no permanent inert/hidden state under System (English)', async ({ popupPage }) => {
    expect(await popupPage.locator('.v2-popup').getAttribute('inert')).toBeNull()
    expect(await popupPage.locator('.v2-popup').getAttribute('aria-busy')).toBeNull()
  })

  test('unsupported (non-http) active tab shows localized feedback, no crash, no permanent inert state', async ({ context, popupUrl }) => {
    // Opened as a plain tab (no chrome.tabs.query mock): the "active tab" IS
    // this extension page itself, a chrome-extension:// URL — exercising
    // popup.ts's real early-return branch for pages that can't be isolated.
    const page = await context.newPage()
    await page.goto(popupUrl)
    await seedLocalePreference(page, 'de')
    await page.reload()

    await expect(page.locator('.v2-popup')).toContainText('Diese Seite kann nicht isoliert werden.')
    expect(await page.locator('.v2-popup').getAttribute('inert')).toBeNull()
    expect(await page.locator('.v2-popup').getAttribute('aria-busy')).toBeNull()
    await page.close()
  })
})
