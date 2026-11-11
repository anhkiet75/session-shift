import { test, expect } from './extension-fixtures'
import type { BrowserContext, Page, Worker } from '@playwright/test'

/**
 * A host-only cookie (set without `Domain=`) belongs to exactly one host. A
 * profile tab must not send the cookie `example.com` set for itself to
 * `blog.example.com`: on many sites a subdomain is run by someone else.
 *
 * `localhost` plays the apex and `*.localhost` its subdomains; Chrome resolves
 * both to the loopback address, so one mock server answers for all of them.
 */

type StoredCookie = {
  name: string; value: string; domain: string; path: string
  expires: null; secure: boolean; httpOnly: boolean
}

async function serviceWorker(context: BrowserContext): Promise<Worker> {
  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker')
  return worker
}

const stored = (name: string, value: string, domain: string): Record<string, StoredCookie> =>
  ({ [`${name}|${domain}|/`]: { name, value, domain, path: '/', expires: null, secure: false, httpOnly: true } })

/** The cookies the mock server received on the page the tab is showing. */
const cookiesReceived = async (page: Page): Promise<Record<string, string>> =>
  (JSON.parse(await page.evaluate(() => document.body.innerText)) as { cookies: Record<string, string> }).cookies

test('a host-only cookie of the apex host is not sent to its subdomains', async ({ context, optionsUrl, mockServerUrl }) => {
  const sessionId = 'p_host_only'
  const port = new URL(mockServerUrl).port
  await (await serviceWorker(context)).evaluate(async ({ id, store }) => {
    await chrome.storage.local.set({ profiles: [{ id, name: id, hue: 200 }], [`cookies_${id}`]: store })
  }, {
    id: sessionId,
    store: {
      // The apex's own login: host-only.
      ...stored('session', 'apex-secret', 'localhost'),
      // Set for the whole domain: every subdomain is meant to get it.
      ...stored('theme', 'dark', '.localhost'),
      // A subdomain's own host-only cookie.
      ...stored('own', 'app-only', 'app.localhost'),
    },
  })
  const helper = await context.newPage()
  await helper.goto(optionsUrl)

  // The popup's profile switch: assign the tab, then load under the profile.
  const page = await context.newPage()
  await page.goto(`${mockServerUrl}/cookies`)
  await helper.evaluate(async ({ url, sessionId }) => {
    const [tab] = await chrome.tabs.query({ url })
    await chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId: tab.id, sessionId } })
  }, { url: `${mockServerUrl}/cookies`, sessionId })
  await page.reload()

  // The apex gets its own cookie and the domain-wide one.
  expect(await cookiesReceived(page)).toEqual({ session: 'apex-secret', theme: 'dark' })

  // A subdomain the profile holds nothing host-specific for: domain-wide cookie only.
  await page.goto(`http://blog.localhost:${port}/cookies`)
  expect(await cookiesReceived(page)).toEqual({ theme: 'dark' })

  // A subdomain with a host-only cookie of its own: that one and the domain-wide one.
  await page.goto(`http://app.localhost:${port}/cookies`)
  expect(await cookiesReceived(page)).toEqual({ own: 'app-only', theme: 'dark' })
})
