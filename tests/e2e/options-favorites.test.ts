import { test, expect } from './extension-fixtures'
import type { Page } from '@playwright/test'

const PROFILE_A = 'session_optfav_a'
const PROFILE_B = 'session_optfav_b'

async function seedAndOpen(page: Page, optionsUrl: string, mockServerUrl: string): Promise<void> {
  await page.goto(optionsUrl)
  await page.evaluate(async ({ a, b, base }) => {
    await chrome.storage.local.set({
      profiles: [{ id: a, name: 'Alpha', hue: 212 }, { id: b, name: 'Beta', hue: 24 }],
      favorites: [
        { id: 'fav_one', label: 'One', url: `${base}/cookies?n=1`, sessionId: a, createdAt: 1 },
        { id: 'fav_two', label: 'Two', url: `${base}/cookies?n=2`, sessionId: a, createdAt: 2 },
        { id: 'fav_three', label: 'Three', url: `${base}/cookies?n=3`, sessionId: b, createdAt: 3 },
      ],
    })
  }, { a: PROFILE_A, b: PROFILE_B, base: mockServerUrl })
  // Reload so the panel renders against the seeded data, then open the tab.
  await page.reload()
  await page.locator('[data-tab="favorites"]').click()
  await expect(page.locator('#panel-favorites')).toBeVisible()
}

function storedFavorites(page: Page): Promise<{ id: string; label: string; url: string; sessionId: string }[]> {
  return page.evaluate(async () => {
    const { favorites } = await chrome.storage.local.get(['favorites'])
    return favorites as { id: string; label: string; url: string; sessionId: string }[]
  })
}

test.describe('Options → Favorites', () => {
  test('renames a favorite, and a blank label falls back to the hostname', async ({
    page, optionsUrl, mockServerUrl,
  }) => {
    await seedAndOpen(page, optionsUrl, mockServerUrl)

    const firstLabel = page.locator('.opt-fav-row').first().locator('.opt-fav-input').first()
    await firstLabel.fill('Renamed inbox')
    await firstLabel.blur()
    await expect.poll(async () => (await storedFavorites(page))[0].label).toBe('Renamed inbox')

    // Survives a reload — it was actually persisted, not just painted.
    await page.reload()
    await page.locator('[data-tab="favorites"]').click()
    await expect(page.locator('.opt-fav-row').first().locator('.opt-fav-input').first()).toHaveValue('Renamed inbox')

    const label = page.locator('.opt-fav-row').first().locator('.opt-fav-input').first()
    await label.fill('   ')
    await label.blur()
    await expect.poll(async () => (await storedFavorites(page))[0].label).toBe('localhost')
  })

  test('rejects a non-http(s) URL inline and reverts the field without writing', async ({
    page, optionsUrl, mockServerUrl,
  }) => {
    await seedAndOpen(page, optionsUrl, mockServerUrl)

    const row = page.locator('.opt-fav-row').first()
    const urlField = row.locator('.opt-fav-url')
    const original = await urlField.inputValue()

    await urlField.fill('javascript:alert(1)')
    await urlField.blur()

    await expect(row.locator('.opt-fav-error')).toBeVisible()
    await expect(urlField).toHaveAttribute('aria-invalid', 'true')
    await expect(urlField).toHaveValue(original)
    expect((await storedFavorites(page))[0].url).toBe(original)
  })

  test('re-assigns the bound profile', async ({ page, optionsUrl, mockServerUrl }) => {
    await seedAndOpen(page, optionsUrl, mockServerUrl)

    await page.locator('.opt-fav-row').first().locator('.opt-fav-select').selectOption(PROFILE_B)
    await expect.poll(async () => (await storedFavorites(page)).find(f => f.id === 'fav_one')?.sessionId).toBe(PROFILE_B)
  })

  test('reorders with the move buttons, and the bounds are disabled', async ({
    page, optionsUrl, mockServerUrl,
  }) => {
    await seedAndOpen(page, optionsUrl, mockServerUrl)

    const rows = page.locator('.opt-fav-row')
    await expect(rows.first().locator('[data-fav-action="up"]')).toBeDisabled()
    await expect(rows.last().locator('[data-fav-action="down"]')).toBeDisabled()

    await rows.nth(1).locator('[data-fav-action="up"]').click()
    await expect.poll(async () => (await storedFavorites(page)).map(f => f.id))
      .toEqual(['fav_two', 'fav_one', 'fav_three'])

    // After a move to index 0 the pressed button disables; focus must land on
    // the opposite move button, never on the profile select (one arrow key
    // there would silently re-bind the favorite).
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-fav-action') ?? null)
    expect(focused).toBe('down')
  })

  test('delete asks for confirmation before removing, and cancel backs out', async ({
    page, optionsUrl, mockServerUrl,
  }) => {
    await seedAndOpen(page, optionsUrl, mockServerUrl)
    const row = page.locator('.opt-fav-row').first()

    await row.locator('[data-fav-action="delete"]').click()
    // First click only arms the confirm — nothing removed yet, and the row's
    // own controls step aside for the cancel/confirm pair.
    await expect(page.locator('.opt-fav-del-cancel')).toBeVisible()
    await expect(page.locator('.opt-fav-del-confirm')).toBeVisible()
    expect((await storedFavorites(page)).map(f => f.id)).toEqual(['fav_one', 'fav_two', 'fav_three'])

    await page.locator('.opt-fav-del-cancel').click()
    await expect(page.locator('.opt-fav-del-cancel')).toBeHidden()
    await expect(row.locator('[data-fav-action="delete"]')).toBeVisible()
    expect((await storedFavorites(page)).map(f => f.id)).toEqual(['fav_one', 'fav_two', 'fav_three'])
  })

  test('deletes a favorite on confirm and announces it', async ({ page, optionsUrl, mockServerUrl }) => {
    await seedAndOpen(page, optionsUrl, mockServerUrl)

    await page.locator('.opt-fav-row').first().locator('[data-fav-action="delete"]').click()
    await page.locator('.opt-fav-del-confirm').click()
    await expect.poll(async () => (await storedFavorites(page)).map(f => f.id))
      .toEqual(['fav_two', 'fav_three'])
    await expect(page.locator('#favoritesStatus')).toContainText('removed')
  })

  test('a favorite whose profile is gone can be rebound instead of losing its URL', async ({
    page, optionsUrl, mockServerUrl,
  }) => {
    await page.goto(optionsUrl)
    await page.evaluate(async ({ a, base }) => {
      await chrome.storage.local.set({
        profiles: [{ id: a, name: 'Alpha', hue: 212 }],
        favorites: [{ id: 'fav_orphan', label: 'Orphan', url: `${base}/cookies?n=9`, sessionId: 'gone', createdAt: 1 }],
      })
    }, { a: PROFILE_A, base: mockServerUrl })
    await page.reload()
    await page.locator('[data-tab="favorites"]').click()

    const row = page.locator('.opt-fav-row').first()
    await expect(row).toHaveClass(/missing/)
    await row.locator('.opt-fav-select').selectOption(PROFILE_A)

    await expect.poll(async () => (await storedFavorites(page))[0].sessionId).toBe(PROFILE_A)
    await expect(page.locator('.opt-fav-row').first()).not.toHaveClass(/missing/)
  })

  test('shows the empty state when there are no favorites', async ({ page, optionsUrl }) => {
    await page.goto(optionsUrl)
    await page.evaluate(async () => { await chrome.storage.local.set({ favorites: [] }) })
    await page.reload()
    await page.locator('[data-tab="favorites"]').click()

    await expect(page.locator('.opt-fav-empty')).toBeVisible()
    await expect(page.locator('.opt-fav-row')).toHaveCount(0)
  })
})
