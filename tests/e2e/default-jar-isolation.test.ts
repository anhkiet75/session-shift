import { test, expect } from './extension-fixtures'
import type { BrowserContext, Page } from '@playwright/test'
import { startLaravelSessionServer, type LaravelSessionServer, WRONG_PASSWORD_FLASH } from './laravel-session-mock-server'

/**
 * A normal (no-profile) tab uses Chrome's own cookie jar — the user's everyday
 * account. Profile tabs must never write to that jar nor read from it, on every
 * way a tab can enter a profile. Regression for: "a normal tab uses the account
 * of the most recently used profile, even after that profile tab is closed".
 */

type EntryPath = 'createSessionTab' | 'popupSwitch' | 'linkedTab'
const ENTRY_PATHS: EntryPath[] = ['createSessionTab', 'popupSwitch', 'linkedTab']

let app: LaravelSessionServer
test.beforeEach(() => { app = startLaravelSessionServer() })
test.afterEach(async () => { await new Promise<void>((resolve) => app.server.close(() => resolve())) })

async function extensionPage(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`)
  return page
}

async function createProfile(helper: Page, sessionId: string): Promise<void> {
  await helper.evaluate(async (id) => {
    const profiles = ((await chrome.storage.local.get('profiles')).profiles ?? []) as unknown[]
    await chrome.storage.local.set({ profiles: [...profiles, { id, name: id, hue: 200 }], [`cookies_${id}`]: {} })
  }, sessionId)
}

async function tabIdOf(helper: Page, urlPart: string): Promise<number> {
  const id = await helper.evaluate(async (part) =>
    (await chrome.tabs.query({})).filter((tab) => tab.url?.includes(part)).pop()?.id ?? null, urlPart)
  if (typeof id !== 'number') throw new Error(`no tab for ${urlPart}`)
  return id
}

/** Waits for `count` load events (createSessionTab loads once, then force-reloads). */
async function waitForLoads(page: Page, count: number): Promise<void> {
  let loads = 0
  page.on('load', () => { loads++ })
  const deadline = Date.now() + 5_000
  while (loads < count && Date.now() < deadline) await page.waitForTimeout(50)
  await page.waitForLoadState('load')
}

const jarSnapshot = async (context: BrowserContext) =>
  JSON.stringify((await context.cookies([app.url, app.altUrl])).map((c) => [c.domain, c.name, c.value]).sort())

type ProfileTab = { page: Page; mark: number; jarAtJoin: string }

/**
 * Opens `url` in a tab bound to `sessionId` through one of the real entry paths
 * and returns it loaded. Taken at the moment the flow becomes profile-only:
 * `mark` (server-log length — later entries are this tab's requests) and
 * `jarAtJoin` (Chrome's jar, which nothing after that point may change).
 */
async function openInProfile(
  context: BrowserContext, helper: Page, entry: EntryPath, sessionId: string, url: string,
): Promise<ProfileTab> {
  if (entry === 'createSessionTab') {
    const mark = app.log.length
    const jarAtJoin = await jarSnapshot(context)
    const opened = context.waitForEvent('page')
    await helper.evaluate(async ({ url, sessionId }) =>
      chrome.runtime.sendMessage({ action: 'createSessionTab', payload: { url, sessionId } }), { url, sessionId })
    const page = await opened
    await waitForLoads(page, 2)
    return { page, mark, jarAtJoin }
  }
  if (entry === 'popupSwitch') {
    // The popup's profile switch: setSession on the current tab, then a
    // bypass-cache reload (popup-render-profile-list.ts).
    const page = await context.newPage()
    await page.goto(url)
    const tabId = await tabIdOf(helper, new URL(url).pathname + new URL(url).search)
    const mark = app.log.length
    const jarAtJoin = await jarSnapshot(context) // the normal-tab load above may legitimately write it
    await helper.evaluate(async ({ tabId, sessionId }) =>
      chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId } }), { tabId, sessionId })
    await Promise.all([
      page.waitForEvent('load'),
      helper.evaluate(async (tabId) => chrome.tabs.reload(tabId, { bypassCache: true }), tabId),
    ])
    return { page, mark, jarAtJoin }
  }
  // Linked tab: a target=_blank link in a profile tab inherits the profile.
  const { page: opener } = await openInProfile(context, helper, 'createSessionTab', sessionId, `${app.url}/page?opener=1`)
  const mark = app.log.length
  const opened = context.waitForEvent('page')
  await opener.evaluate((href) => {
    const a = document.createElement('a')
    a.href = href
    a.target = '_blank'
    document.body.appendChild(a)
    a.click()
  }, url)
  const page = await opened
  // Its first request beat the profile rules, so the extension re-requests the
  // page once the tab has joined the profile: wait for that second load. That
  // first request was sent with Chrome's own jar — a normal-account request —
  // so whatever it wrote there is the normal account's; the profile-only part
  // of the flow starts after it.
  await waitForLoads(page, 2)
  return { page, mark, jarAtJoin: await jarSnapshot(context) }
}

async function formLogin(page: Page, password?: string): Promise<void> {
  if (password !== undefined) await page.fill('#password', password)
  const before = await page.evaluate(() => performance.timeOrigin)
  await page.click('#submit')
  // Every login outcome ends on a new document (dashboard, or /login again with
  // the flash); wait until the page is one created after the click.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const origin = await page.evaluate(() => performance.timeOrigin).catch(() => before)
    if (origin > before) break
    await page.waitForTimeout(50)
  }
  await page.waitForLoadState('load')
}

/** Logs the normal (no-profile) browser in and returns its session id. */
async function loginNormalTab(context: BrowserContext): Promise<{ page: Page; sessionId: string }> {
  const page = await context.newPage()
  await page.goto(`${app.url}/login`)
  await formLogin(page)
  await expect(page).toHaveURL(/\/dashboard$/)
  const jarSession = (await context.cookies(app.url)).find((c) => c.name === 'laravel_session')?.value
  expect(app.sessionUser(jarSession ?? null)).toBe('admin')
  return { page, sessionId: jarSession! }
}

test.describe('Profile tabs never touch Chrome\'s own cookie jar', () => {
  for (const entry of ENTRY_PATHS) {
    test(`${entry}: logging in and out inside a profile leaves the normal jar unchanged`, async ({ context, extensionId }) => {
      const helper = await extensionPage(context, extensionId)
      await createProfile(helper, 'session_jar_write')
      const { page, jarAtJoin } = await openInProfile(context, helper, entry, 'session_jar_write', `${app.url}/login?entry=${entry}`)
      await formLogin(page)
      await expect(page).toHaveURL(/\/dashboard$/)
      expect(await jarSnapshot(context)).toBe(jarAtJoin)

      await page.close()
      const normal = await context.newPage()
      await normal.goto(`${app.url}/dashboard`)
      await expect(normal).toHaveURL(/\/login$/) // the normal browser never logged in
    })

    test(`${entry}: a profile tab never sends the normal account's session`, async ({ context, extensionId }) => {
      const helper = await extensionPage(context, extensionId)
      const { sessionId: normalSession } = await loginNormalTab(context)
      await createProfile(helper, 'session_jar_read')

      const { page, mark } = await openInProfile(context, helper, entry, 'session_jar_read', `${app.url}/page?entry=${entry}`)
      await page.goto(`${app.url}/dashboard`)
      await expect(page).toHaveURL(/\/login$/) // a fresh profile is a guest

      const profileRequests = app.log.slice(mark)
      expect(profileRequests.length).toBeGreaterThan(0)
      const leaked = profileRequests.filter((r) => r.got === normalSession)
      if (entry === 'linkedTab') {
        // A linked tab's very first request leaves before any extension event
        // for the new tab exists, so Chrome sends it with its own jar. It may be
        // that single GET only: its response is never captured and the page is
        // re-requested under the profile.
        expect(leaked.length).toBeLessThanOrEqual(1)
        expect(leaked.every((r) => r.method === 'GET' && r.path === `/page?entry=${entry}`)).toBe(true)
      } else {
        expect(leaked).toEqual([])
      }
      const store = await helper.evaluate(async () =>
        Object.values((await chrome.storage.local.get('cookies_session_jar_read')).cookies_session_jar_read ?? {})
          .map((c) => (c as { value: string }).value))
      expect(store).not.toContain(normalSession)
    })
  }

  test('the normal account stays logged in while a profile logs in and out as someone else', async ({ context, extensionId }) => {
    const helper = await extensionPage(context, extensionId)
    const { page: normal, sessionId: normalSession } = await loginNormalTab(context)
    await createProfile(helper, 'session_other_account')

    const { page } = await openInProfile(context, helper, 'createSessionTab', 'session_other_account', `${app.url}/login`)
    await formLogin(page)
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.evaluate(async () => {
      const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
      await fetch('/logout', { method: 'POST', headers: { 'X-XSRF-TOKEN': token } })
    })
    await page.close()

    await normal.reload()
    await expect(normal).toHaveURL(/\/dashboard$/)
    expect((await context.cookies(app.url)).find((c) => c.name === 'laravel_session')?.value).toBe(normalSession)
  })
})

// The content script stops only documents DNR marked as held redirects; every
// other 3xx document must still render its body like it does without the extension.
test('a normal tab renders a genuine 3xx document', async ({ context }) => {
  const page = await context.newPage()
  await page.goto(`${app.url}/multiple-choices`)
  await page.waitForTimeout(500) // past the content script's document_start check
  await expect(page.locator('#choices')).toHaveText('pick one')
})

// Guards the jar-free redirect path: once navigations stop falling back to
// Chrome's jar, every hop's cookies come from the profile store alone.
test.describe('Login redirect chains in profile tabs', () => {
  test('form login lands on the dashboard; a wrong password still shows its flashed error', async ({ context, extensionId }) => {
    const helper = await extensionPage(context, extensionId)
    await createProfile(helper, 'session_chain_form')
    const { page } = await openInProfile(context, helper, 'createSessionTab', 'session_chain_form', `${app.url}/login`)

    await formLogin(page, 'wrong')
    await expect(page.locator('#error')).toHaveText(WRONG_PASSWORD_FLASH)
    await formLogin(page)
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.locator('#user')).toHaveText('admin')
  })

  test('a held login redirect leaves the same history as a native redirect', async ({ context, extensionId }) => {
    const helper = await extensionPage(context, extensionId)
    const loginAndGoBack = async (page: Page) => {
      await page.goto(`${app.url}/page`)
      await page.goto(`${app.url}/login`)
      const before = await page.evaluate(() => history.length)
      await formLogin(page)
      await expect(page).toHaveURL(/\/dashboard$/)
      const added = (await page.evaluate(() => history.length)) - before
      // Back reaches the login form; the logged-in session is then sent on by
      // the server (guest middleware), exactly like after a native redirect.
      await page.evaluate(() => history.back())
      await page.waitForTimeout(1_000)
      return { added, afterBack: new URL(page.url()).pathname }
    }

    const native = await loginAndGoBack(await context.newPage())
    await createProfile(helper, 'session_chain_history')
    const { page } = await openInProfile(context, helper, 'createSessionTab', 'session_chain_history', `${app.url}/page?start=1`)
    const held = await loginAndGoBack(page)
    expect(held).toEqual(native)
  })

  // Known limit: XHR follows redirects inside the browser and has no manual
  // mode, and DNR cannot scope a Location-removing rule to the page's own
  // (bridged, same-origin) XHRs, so XHR chains are not held. On a very fast
  // origin the chain can still end on a stale hop (the page shows /login while
  // the profile already holds the new session). See
  // plans/260926-2235-default-tab-jar-isolation/phase-04-redirect-chain-resilience.md.
  test.fixme('Inertia-style XHR login follows its redirect into the dashboard', async ({ context, extensionId }) => {
    const helper = await extensionPage(context, extensionId)
    await createProfile(helper, 'session_chain_xhr')
    const { page } = await openInProfile(context, helper, 'createSessionTab', 'session_chain_xhr', `${app.url}/login`)
    const result = await page.evaluate(() => new Promise<{ url: string; body: string }>((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/login')
      xhr.setRequestHeader('X-Inertia', 'true')
      xhr.setRequestHeader('X-XSRF-TOKEN', decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? ''))
      xhr.onloadend = () => resolve({ url: xhr.responseURL, body: xhr.responseText })
      xhr.send('{}')
    }))
    expect(result.url).toMatch(/\/dashboard$/)
    expect(result.body).toContain('admin')
  })

  test('a cross-host SSO chain logs the second host in', async ({ context, extensionId }) => {
    const helper = await extensionPage(context, extensionId)
    await createProfile(helper, 'session_chain_sso')
    const { page } = await openInProfile(context, helper, 'createSessionTab', 'session_chain_sso', `${app.url}/login`)
    await Promise.all([
      page.waitForURL(`${app.altUrl}/dashboard`, { timeout: 10_000 }).catch(() => {}),
      page.evaluate(() => {
        const form = document.createElement('form')
        form.method = 'POST'
        form.action = '/sso/login'
        const token = document.querySelector<HTMLInputElement>('input[name=_token]')!.cloneNode() as HTMLInputElement
        form.appendChild(token)
        document.body.appendChild(form)
        form.submit()
      }),
    ])
    await expect(page).toHaveURL(`${app.altUrl}/dashboard`)
    await expect(page.locator('#user')).toHaveText('admin')
  })
})
