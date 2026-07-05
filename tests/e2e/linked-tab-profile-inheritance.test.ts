import { test, expect } from './extension-fixtures'

/**
 * Opens a target="_blank" link on `page` and returns the new tab, matching the
 * genuinely-new pattern this suite needs for page-triggered (not
 * extension-triggered) tab creation.
 */
async function openLinkInNewTab(context: import('@playwright/test').BrowserContext, page: import('@playwright/test').Page, url: string) {
  const pagePromise = context.waitForEvent('page')
  await page.evaluate((href) => {
    const a = document.createElement('a')
    a.href = href
    a.target = '_blank'
    document.body.appendChild(a)
    a.click()
  }, url)
  const newPage = await pagePromise
  await newPage.waitForLoadState()
  return newPage
}

test.describe('Linked tab profile inheritance', () => {
  test('default (no toggle interaction): a tab opened from a link inherits the opener profile, not the default jar', async ({
    context, extensionId, mockServerUrl,
  }) => {
    const origin = mockServerUrl
    const sessionId = `session_e2e_linked_on_${Date.now()}`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)
    await helperPage.evaluate(async ({ origin, sessionId }) => {
      await chrome.storage.local.set({
        [`list_${origin}`]: [{ id: sessionId, name: 'LinkedOn', hue: 90 }],
        profiles: [{ id: sessionId, name: 'LinkedOn', hue: 90 }],
        [`cookies_${sessionId}`]: {},
      })
    }, { origin, sessionId })

    // Default-jar cookie set before any isolation, to detect leakage.
    const defaultTab = await context.newPage()
    await defaultTab.goto(`${mockServerUrl}/set?user=default-jar`)

    // Opener tab, assigned to the isolated profile.
    const opener = await context.newPage()
    await opener.goto(`${mockServerUrl}/cookies?t=opener-on`)
    const { openerId } = await helperPage.evaluate(async () => ({
      openerId: (await chrome.tabs.query({})).find(
        (t: chrome.tabs.Tab) => t.url?.includes('t=opener-on'),
      )?.id,
    }))
    expect(openerId).toBeDefined()
    await helperPage.evaluate(
      async ({ tabId, sessionId }) =>
        chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId } }),
      { tabId: openerId, sessionId },
    )

    const linked = await openLinkInNewTab(context, opener, `${mockServerUrl}/cookies?t=linked-on`)

    // Chrome starts the tab's navigation itself as part of opening a linked
    // tab — unlike `createSessionTab` (which creates an about:blank tab,
    // installs the DNR rule, *then* triggers navigation), this extension gets
    // no chance to install a Cookie-strip rule before that first request goes
    // out, so the very first byte is not asserted here (best-effort, not a
    // hard guarantee — see phase-02 Architecture notes).
    //
    // What is deterministic: profile assignment is synchronous with the
    // `webNavigation.onCreatedNavigationTarget` event (verified via
    // getSession), and DNR isolation is active for that tab from its next
    // request onward. Reloading the *same* URL does not exercise this — the
    // one-shot navigation strip is already consumed and this echo endpoint
    // never re-arms it (same limitation `createSessionTab` already has for a
    // page that never sets its own cookies) — so isolation is verified via a
    // fresh in-page fetch instead.
    const { linkedId } = await helperPage.evaluate(async () => ({
      linkedId: (await chrome.tabs.query({})).find(
        (t: chrome.tabs.Tab) => t.url?.includes('t=linked-on'),
      )?.id,
    }))
    const session = await helperPage.evaluate(
      async ({ tabId }) => chrome.runtime.sendMessage({ action: 'getSession', payload: { tabId } }),
      { tabId: linkedId },
    )
    expect(session.sessionId).toBe(sessionId)

    await linked.waitForTimeout(200) // let updateDNRRulesForTab's async chain settle
    const fetchResult = await linked.evaluate(
      async (url) => (await fetch(url, { credentials: 'include' })).json(),
      `${mockServerUrl}/cookies?t=linked-on-next`,
    )
    expect(fetchResult.cookies.user).toBeUndefined()
  })

  test('toggled OFF: a tab opened from a link stays on the default jar', async ({
    context, extensionId, mockServerUrl,
  }) => {
    const origin = mockServerUrl
    const sessionId = `session_e2e_linked_off_${Date.now()}`

    // Explicitly opt out — the setting is on by default.
    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/options/options.html`)
    await options.click('#tab-settings')
    await options.click('#autoInheritToggle')
    await options.close()

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)
    await helperPage.evaluate(async ({ origin, sessionId }) => {
      await chrome.storage.local.set({
        [`list_${origin}`]: [{ id: sessionId, name: 'LinkedOff', hue: 40 }],
        profiles: [{ id: sessionId, name: 'LinkedOff', hue: 40 }],
        [`cookies_${sessionId}`]: {},
      })
    }, { origin, sessionId })

    const defaultTab = await context.newPage()
    await defaultTab.goto(`${mockServerUrl}/set?user=default-jar-off`)

    const opener = await context.newPage()
    await opener.goto(`${mockServerUrl}/cookies?t=opener-off`)
    const { openerId } = await helperPage.evaluate(async () => ({
      openerId: (await chrome.tabs.query({})).find(
        (t: chrome.tabs.Tab) => t.url?.includes('t=opener-off'),
      )?.id,
    }))
    expect(openerId).toBeDefined()
    await helperPage.evaluate(
      async ({ tabId, sessionId }) =>
        chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId } }),
      { tabId: openerId, sessionId },
    )

    const linked = await openLinkInNewTab(context, opener, `${mockServerUrl}/cookies?t=linked-off`)
    const linkedResult = JSON.parse(await linked.textContent('body') ?? '{}')
    expect(linkedResult.cookies.user).toBe('default-jar-off')
  })
})
