import { test, expect } from './extension-fixtures'

test.describe('Theme switcher', () => {
  test('selecting Dark sets html[data-theme="dark"]', async ({ context, extensionId }) => {
    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/options/options.html`)
    await options.click('#tab-settings')
    await options.click('.opt-theme-btn[data-theme-val="dark"]')
    await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark')
    await options.close()
  })

  test('selecting System removes data-theme attribute', async ({ context, extensionId }) => {
    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/options/options.html`)
    await options.click('#tab-settings')
    // First set dark, then switch back to system
    await options.click('.opt-theme-btn[data-theme-val="dark"]')
    await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark')
    await options.click('.opt-theme-btn[data-theme-val="system"]')
    await expect(options.locator('html')).not.toHaveAttribute('data-theme')
    await options.close()
  })

  test('theme persists after page reload', async ({ context, extensionId }) => {
    const url = `chrome-extension://${extensionId}/options/options.html`
    const options = await context.newPage()
    await options.goto(url)
    await options.click('#tab-settings')
    await options.click('.opt-theme-btn[data-theme-val="dark"]')
    await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark')

    await options.reload()
    // Theme is applied on load from storage
    await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark')
    await options.close()
  })
})

test.describe('Popup quick theme toggle', () => {
  test('cycles light → dark → system on successive clicks', async ({ context, extensionId }) => {
    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`)
    await popup.waitForSelector('#themeToggle')

    // Default state is system → no data-theme attribute
    await expect(popup.locator('html')).not.toHaveAttribute('data-theme', /.+/)

    await popup.click('#themeToggle')
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(popup.locator('#themeToggle')).toHaveAttribute('aria-label', /light/)

    await popup.click('#themeToggle')
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(popup.locator('#themeToggle')).toHaveAttribute('aria-label', /dark/)

    await popup.click('#themeToggle')
    await expect(popup.locator('html')).not.toHaveAttribute('data-theme', /.+/)
    await expect(popup.locator('#themeToggle')).toHaveAttribute('aria-label', /system/)

    await popup.close()
  })

  test('persists across popup re-open', async ({ context, extensionId }) => {
    const url = `chrome-extension://${extensionId}/popup/popup.html`

    const first = await context.newPage()
    await first.goto(url)
    await first.waitForSelector('#themeToggle')
    // system → light → dark
    await first.click('#themeToggle')
    await first.click('#themeToggle')
    await expect(first.locator('html')).toHaveAttribute('data-theme', 'dark')
    await first.close()

    const second = await context.newPage()
    await second.goto(url)
    await second.waitForSelector('#themeToggle')
    await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(second.locator('#themeToggle')).toHaveAttribute('aria-label', /dark/)
    await second.close()
  })

  test('preserves other ext_settings fields when toggling', async ({ context, extensionId }) => {
    const url = `chrome-extension://${extensionId}/popup/popup.html`

    const seed = await context.newPage()
    await seed.goto(url)
    await seed.evaluate(async () => {
      await chrome.storage.local.set({
        ext_settings: { customField: 'keepme', theme: 'system' },
      })
    })
    await seed.close()

    const popup = await context.newPage()
    await popup.goto(url)
    await popup.waitForSelector('#themeToggle')
    await popup.click('#themeToggle')
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light')

    const stored = await popup.evaluate(async () => {
      const r = await chrome.storage.local.get(['ext_settings'])
      return r.ext_settings as { customField?: string; theme?: string }
    })
    expect(stored.customField).toBe('keepme')
    expect(stored.theme).toBe('light')

    await popup.close()
  })
})
