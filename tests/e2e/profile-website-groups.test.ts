import { parseCookieResponse } from './cookie-response'
import { test, expect } from './extension-fixtures'
import type { Page } from '@playwright/test'
import { getTabIdByUrl, openPopupForTab, waitForOpenedPage } from './popup-helpers'

const MAIL_ORIGIN = 'https://mail.example.test'
const SHOP_ORIGIN = 'https://shop.example.test'

type SeededSite = { name: string; origin: string; url: string }
type SeededProfile = { id: string; name: string; hue?: number; site?: SeededSite }

const MAIL_SITE: SeededSite = { name: 'Example Mail', origin: MAIL_ORIGIN, url: `${MAIL_ORIGIN}/inbox` }
const SHOP_SITE: SeededSite = { name: 'Example Shop', origin: SHOP_ORIGIN, url: `${SHOP_ORIGIN}/cart` }

async function seedProfiles(page: Page, profiles: SeededProfile[]): Promise<void> {
  await page.evaluate(async (seeded) => {
    await chrome.storage.local.set({ profiles: seeded })
  }, profiles)
  await page.reload()
  await page.waitForSelector('#btnNewSession', { state: 'visible', timeout: 15_000 })
}

async function seedGroupedProfiles(page: Page): Promise<void> {
  await seedProfiles(page, [
    { id: 'group_mail_work', name: 'Mail Work', hue: 212, site: MAIL_SITE },
    { id: 'group_mail_personal', name: 'Mail Personal', hue: 24, site: MAIL_SITE },
    { id: 'group_shop', name: 'Shop Only', hue: 120, site: SHOP_SITE },
    { id: 'group_legacy', name: 'Legacy Profile', hue: 300 },
  ])
}

function siteGroup(page: Page, key: string) {
  return page.locator(`.v2-site-group[data-site-key="${key}"]`)
}

test.describe('Popup website groups', () => {
  test('groups profiles by creation origin and labels each site', async ({ popupPage }) => {
    await seedGroupedProfiles(popupPage)

    await expect(popupPage.locator('.v2-site-group')).toHaveCount(3)

    const mail = siteGroup(popupPage, MAIL_ORIGIN)
    await expect(mail.locator('.v2-site-heading strong')).toHaveText('Example Mail')
    await expect(mail.locator('.v2-site-heading')).toContainText(MAIL_ORIGIN)
    await expect(mail.locator('.v2-card')).toHaveCount(2)
    await expect(mail.locator('.v2-card-name')).toHaveText(['Mail Work', 'Mail Personal'])

    const shop = siteGroup(popupPage, SHOP_ORIGIN)
    await expect(shop.locator('.v2-site-heading strong')).toHaveText('Example Shop')
    await expect(shop.locator('.v2-card')).toHaveCount(1)

    // Profiles created before website metadata existed stay reachable.
    const unassigned = siteGroup(popupPage, 'unassigned')
    await expect(unassigned.locator('.v2-site-heading strong')).toHaveText('Unassigned')
    await expect(unassigned.locator('.v2-card-name')).toHaveText('Legacy Profile')
  })

  test('collapses and expands each website group independently', async ({ popupPage }) => {
    await seedGroupedProfiles(popupPage)

    const mail = siteGroup(popupPage, MAIL_ORIGIN)
    const shop = siteGroup(popupPage, SHOP_ORIGIN)
    const mailHeading = mail.locator('.v2-site-heading')
    const shopHeading = shop.locator('.v2-site-heading')

    const controls = await mailHeading.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    await expect(popupPage.locator(`#${controls}`)).toHaveCount(1)
    await expect(mailHeading).toHaveAttribute('aria-expanded', 'true')

    await mailHeading.click()
    await expect(mailHeading).toHaveAttribute('aria-expanded', 'false')
    await expect(mail.locator('.v2-site-profiles')).toBeHidden()
    // Other groups keep their own state.
    await expect(shop.locator('.v2-site-profiles')).toBeVisible()
    await expect(shopHeading).toHaveAttribute('aria-expanded', 'true')

    await mailHeading.click()
    await expect(mail.locator('.v2-site-profiles')).toBeVisible()

    await shopHeading.click()
    await expect(shop.locator('.v2-site-profiles')).toBeHidden()
    await expect(mail.locator('.v2-site-profiles')).toBeVisible()
  })

  test('search matches profile names and the website address', async ({ popupPage }) => {
    await seedGroupedProfiles(popupPage)

    await popupPage.fill('#searchInput', 'shop.example')
    await expect(popupPage.locator('.v2-site-group')).toHaveCount(1)
    await expect(popupPage.locator('.v2-card-name')).toHaveText('Shop Only')

    await popupPage.fill('#searchInput', 'example mail')
    await expect(siteGroup(popupPage, MAIL_ORIGIN).locator('.v2-card')).toHaveCount(2)
  })

  test('open launches the stored website with the selected profile and isolated cookies', async ({
    context, extensionId, popupUrl, mockServerUrl,
  }) => {
    const profileId = 'session_open_site_e2e'
    const profileName = `SiteOpen-${Date.now()}`
    const storedUrl = `${mockServerUrl}/cookies?source=stored`
    const currentUrl = `${mockServerUrl}/cookies?source=current`

    const helper = await context.newPage()
    await helper.goto(`chrome-extension://${extensionId}/popup/popup.html`)
    await helper.evaluate(async ({ id, name, stored, origin }) => {
      await chrome.storage.local.set({
        profiles: [{ id, name, hue: 212, site: { name: 'Mock Site', origin, url: stored } }],
        [`cookies_${id}`]: { user: { name: 'user', value: 'stored-user', domain: 'localhost', path: '/' } },
      })
    }, { id: profileId, name: profileName, stored: storedUrl, origin: mockServerUrl })

    // A cookie in Chrome's shared jar proves the opened tab must not fall back to it.
    const defaultTab = await context.newPage()
    await defaultTab.goto(`${mockServerUrl}/set?user=default`)
    await defaultTab.goto(currentUrl)
    expect(parseCookieResponse(await defaultTab.textContent('body')).cookies.user).toBe('default')

    const tabId = await getTabIdByUrl(helper, 'source=current')
    const popup = await openPopupForTab(context, popupUrl, tabId, currentUrl)
    const card = popup.locator('.v2-card', { hasText: profileName })
    await expect(card).toBeVisible()
    await expect(card.locator('[data-action="open-profile"]')).toHaveText('Open')
    await card.locator('[data-action="open-profile"]').click()

    const opened = await waitForOpenedPage(context, storedUrl, [defaultTab, helper, popup])
    const seen = parseCookieResponse(await opened.textContent('body'))
    expect(seen.cookies.user).toBe('stored-user')

    await helper.close()
  })

  test('creating a profile records the current website metadata', async ({ popupPage, mockServerUrl }) => {
    const name = `Created-${Date.now()}`

    await popupPage.fill('#newSessionName', name)
    await Promise.all([
      popupPage.waitForLoadState('load'),
      popupPage.click('#btnNewSession'),
    ])
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible', timeout: 15_000 })

    const site = await popupPage.evaluate(async (profileName) => {
      const { profiles } = await chrome.storage.local.get(['profiles'])
      const list = profiles as Array<{ name: string; site?: unknown }>
      return list.find((profile) => profile.name === profileName)?.site ?? null
    }, name)

    expect(site).toEqual({
      name: 'localhost',
      origin: mockServerUrl,
      url: `${mockServerUrl}/cookies`,
    })
    await expect(siteGroup(popupPage, mockServerUrl).locator('.v2-card-name')).toHaveText(name)
  })
})
