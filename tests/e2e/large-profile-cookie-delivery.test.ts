import { test, expect } from './extension-fixtures'
import type { BrowserContext, Page, Worker } from '@playwright/test'
import {
  startWordPressLoginServer, type WordPressLoginServer,
  AUTH_COOKIE, LOGGED_IN_COOKIE, TEST_COOKIE, WP_USER, WP_PASSWORD,
} from './wordpress-login-mock-server'

/**
 * A profile is a global cookie jar, so a profile used for a while holds cookies
 * for far more hosts than one tab has DNR rules. The site the tab is on must
 * still get every cookie the profile holds for it. Regression for: "WordPress
 * says 'Cookies are blocked or not supported by your browser' in a profile tab".
 */

type StoredCookie = {
  name: string; value: string; domain: string; path: string
  expires: null; secure: boolean; httpOnly: boolean
}
type CookieStore = Record<string, StoredCookie>

let wp: WordPressLoginServer
test.beforeEach(() => { wp = startWordPressLoginServer() })
test.afterEach(async () => { await new Promise<void>((resolve) => wp.server.close(() => resolve())) })

async function serviceWorker(context: BrowserContext): Promise<Worker> {
  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker')
  return worker
}

function storedCookie(name: string, value: string, domain: string, path = '/'): CookieStore {
  return { [`${name}|${domain}|${path}`]: { name, value, domain, path, expires: null, secure: false, httpOnly: true } }
}

/** One session cookie on each of `count` unrelated hosts: what ordinary browsing leaves in a profile. */
function otherHosts(prefix: string, count: number): CookieStore {
  let store: CookieStore = {}
  for (let i = 0; i < count; i++) {
    store = { ...store, ...storedCookie('sid', 'x', `${prefix}${String(i).padStart(3, '0')}.example`) }
  }
  return store
}

async function seedProfile(context: BrowserContext, sessionId: string, store: CookieStore): Promise<void> {
  await (await serviceWorker(context)).evaluate(async ({ id, store }) => {
    const profiles = ((await chrome.storage.local.get('profiles')).profiles ?? []) as unknown[]
    await chrome.storage.local.set({ profiles: [...profiles, { id, name: id, hue: 200 }], [`cookies_${id}`]: store })
  }, { id: sessionId, store })
}

const profileStore = async (context: BrowserContext, sessionId: string): Promise<CookieStore> =>
  (await serviceWorker(context)).evaluate(async (id) =>
    ((await chrome.storage.local.get(`cookies_${id}`))[`cookies_${id}`] ?? {}) as CookieStore, sessionId)

/** Waits for `count` load events (createSessionTab loads once, then force-reloads). */
async function waitForLoads(page: Page, count: number): Promise<void> {
  let loads = 0
  page.on('load', () => { loads++ })
  const deadline = Date.now() + 5_000
  while (loads < count && Date.now() < deadline) await page.waitForTimeout(50)
  await page.waitForLoadState('load')
}

/** Same path as the popup's right-click "Open in new tab". */
async function openInProfile(helper: Page, sessionId: string, url: string): Promise<Page> {
  const opened = helper.context().waitForEvent('page')
  await helper.evaluate(async ({ url, sessionId }) =>
    chrome.runtime.sendMessage({ action: 'createSessionTab', payload: { url, sessionId } }), { url, sessionId })
  const page = await opened
  await waitForLoads(page, 2)
  return page
}

async function extensionPage(context: BrowserContext, optionsUrl: string): Promise<Page> {
  const helper = await context.newPage()
  await helper.goto(optionsUrl)
  return helper
}

async function logIn(page: Page): Promise<void> {
  await page.fill('#user_login', WP_USER)
  await page.fill('#user_pass', WP_PASSWORD)
  await page.click('#wp-submit')
}

const cookiesSeenBy = (path: string, host: string) =>
  wp.log.filter((entry) => entry.path === path && entry.host === host).at(-1)?.cookies ?? null

// `localhost` sorts after "a…" and before "z…": both ways the store's other
// hosts can crowd the site out of a rule list ordered by host name.
for (const [order, prefix] of [['before', 'a'], ['after', 'z']] as const) {
  test(`WordPress login works when the profile already holds 110 other hosts sorting ${order} the site`, async ({ context, optionsUrl }) => {
    const sessionId = `p_${order}`
    await seedProfile(context, sessionId, otherHosts(prefix, 110))
    const helper = await extensionPage(context, optionsUrl)

    const page = await openInProfile(helper, sessionId, `${wp.url}/wp-login.php`)
    await logIn(page)

    await expect(page.locator('#dashboard')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/wp-admin/')
    // The login POST carried the test cookie (else: "Cookies are blocked")...
    expect(wp.log.find((entry) => entry.method === 'POST')?.cookies).toContain(TEST_COOKIE)
    // ...and /wp-admin/ got the path-scoped auth cookie (else: bounced to reauth=1).
    expect(cookiesSeenBy('/wp-admin/', 'localhost')).toEqual(expect.arrayContaining([AUTH_COOKIE, LOGGED_IN_COOKIE]))
  })
}

test('13 tabs of a well-used profile: Chrome accepts every rule update and the last tab still logs in', async ({ context, optionsUrl }) => {
  test.setTimeout(120_000)
  const sessionId = 'p_many_tabs'
  await seedProfile(context, sessionId, otherHosts('z', 90))
  const worker = await serviceWorker(context)
  await worker.evaluate(() => {
    const scope = self as unknown as { refusedRuleUpdates: string[] }
    scope.refusedRuleUpdates = []
    const dnr = chrome.declarativeNetRequest
    const update = dnr.updateSessionRules.bind(dnr)
    dnr.updateSessionRules = ((options: chrome.declarativeNetRequest.UpdateRuleOptions) =>
      update(options).catch((error: Error) => {
        scope.refusedRuleUpdates.push(error.message)
        throw error
      })) as typeof dnr.updateSessionRules
  })
  const helper = await extensionPage(context, optionsUrl)

  const pages: Page[] = []
  for (let i = 0; i < 13; i++) pages.push(await openInProfile(helper, sessionId, `${wp.url}/wp-login.php?tab=${i}`))
  await logIn(pages[12])

  await expect(pages[12].locator('#dashboard')).toBeVisible()
  const rules = await worker.evaluate(async () => {
    const all = await chrome.declarativeNetRequest.getSessionRules()
    return {
      refused: (self as unknown as { refusedRuleUpdates: string[] }).refusedRuleUpdates,
      regexRules: all.filter((rule) => rule.condition.regexFilter).length,
    }
  })
  // Before the fix: "Session rule count for regex rules exceeded."
  expect(rules.refused).toEqual([])
  expect(rules.regexRules).toBeLessThanOrEqual(1000)
  // Every tab of the profile sends the new login, not the cookies from before it.
  const token = Object.values(await profileStore(context, sessionId)).find((c) => c.name === LOGGED_IN_COOKIE)?.value
  await expect.poll(async () => worker.evaluate(async (token) => {
    const all = await chrome.declarativeNetRequest.getSessionRules()
    const tabs = new Set<number>()
    for (const rule of all) {
      if (rule.action.requestHeaders?.[0]?.value?.includes(`=${token}`)) tabs.add(rule.condition.tabIds![0])
    }
    return tabs.size
  }, token)).toBe(13)
})

// The profile is logged in on a second site (127.0.0.1) that the tab's rules
// leave out: the tab is on localhost, and the "0…" hosts sort before "127…".
// Reaching that site must neither show a logged-out page nor lose the login —
// WordPress redirects a cookieless visitor to wp-login.php?reauth=1, which
// clears the auth cookies of whoever arrives.
for (const [how, via] of [
  ['a link', (url: string) => url],
  ['a redirect that starts on the tab\'s own site', (url: string) => `${wp.url}/go?to=${encodeURIComponent(url)}`],
] as const) {
  test(`navigating by ${how} to a site the tab's rules left out arrives logged in`, async ({ context, optionsUrl }) => {
    const sessionId = 'p_cross_site'
    const token = wp.issueLogin()
    await seedProfile(context, sessionId, {
      ...otherHosts('0a', 110),
      ...storedCookie(AUTH_COOKIE, token, '127.0.0.1', '/wp-admin'),
      ...storedCookie(LOGGED_IN_COOKIE, token, '127.0.0.1'),
    })
    const helper = await extensionPage(context, optionsUrl)
    const admin = `${wp.altUrl}/wp-admin/`
    const page = await openInProfile(helper, sessionId, `${wp.url}/?link=${encodeURIComponent(via(admin))}`)

    await page.click('#link')

    await expect(page.locator('#dashboard')).toBeVisible()
    expect(page.url()).toBe(admin)
    expect(cookiesSeenBy('/wp-admin/', '127.0.0.1')).toEqual(expect.arrayContaining([AUTH_COOKIE, LOGGED_IN_COOKIE]))
    const store = await profileStore(context, sessionId)
    expect(store[`${AUTH_COOKIE}|127.0.0.1|/wp-admin`]?.value).toBe(token)
    expect(store[`${LOGGED_IN_COOKIE}|127.0.0.1|/`]?.value).toBe(token)
  })
}
