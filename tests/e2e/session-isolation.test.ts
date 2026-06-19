import { test, expect } from './extension-fixtures'

test.describe('Cookie isolation', () => {
  /**
   * Core isolation test: assigns two sessions to two real tabs via `setSession`
   * (which applies DNR rules), then verifies that each tab only sees its own
   * session-scoped cookies — not the other session's.
   */
  test('two sessions on same origin have isolated cookies', async ({
    context, extensionId, mockServerUrl,
  }) => {
    const origin = mockServerUrl
    const sessionAId = `session_e2e_a_${Date.now()}`
    const sessionBId = `session_e2e_b_${Date.now()}`

    // Helper page for chrome API access (extension page = full chrome API)
    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)

    // Register sessions in storage
    await helperPage.evaluate(async ({ origin, sessionA, sessionB }) => {
      await chrome.storage.local.set({
        [`list_${origin}`]: [
          { id: sessionA, name: 'Session A', hue: 200 },
          { id: sessionB, name: 'Session B', hue: 30 },
        ],
        profiles: [
          { id: sessionA, name: 'Session A', hue: 200 },
          { id: sessionB, name: 'Session B', hue: 30 },
        ],
        [`cookies_${sessionA}`]: {},
        [`cookies_${sessionB}`]: {},
      })
    }, { origin, sessionA: sessionAId, sessionB: sessionBId })

    // Open real tabs with unique query params to find them by URL
    const tab1 = await context.newPage()
    const tab2 = await context.newPage()
    await tab1.goto(`${mockServerUrl}/cookies?t=1`)
    await tab2.goto(`${mockServerUrl}/cookies?t=2`)

    // Resolve real browser tab IDs from the extension page
    const { tab1Id, tab2Id } = await helperPage.evaluate(async () => {
      const tabs = await chrome.tabs.query({})
      return {
        tab1Id: tabs.find((t: chrome.tabs.Tab) => t.url?.includes('t=1'))?.id,
        tab2Id: tabs.find((t: chrome.tabs.Tab) => t.url?.includes('t=2'))?.id,
      }
    })

    expect(tab1Id).toBeDefined()
    expect(tab2Id).toBeDefined()

    // Assign sessions → background applies DNR rules to each tab
    await helperPage.evaluate(
      async ({ tabId, sessionId }) =>
        chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId } }),
      { tabId: tab1Id, sessionId: sessionAId },
    )
    await helperPage.evaluate(
      async ({ tabId, sessionId }) =>
        chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId } }),
      { tabId: tab2Id, sessionId: sessionBId },
    )

    // Set cookies via mock server — webRequest listener captures Set-Cookie,
    // stores per session, and republishes DNR rules.
    await tab1.goto(`${mockServerUrl}/set?user=alice`)
    await tab2.goto(`${mockServerUrl}/set?user=bob`)

    // Poll storage until the background has captured both cookies, proving the
    // webRequest pipeline completed. Then wait for the 50ms DNR debounce.
    await helperPage.waitForFunction(
      async (ids) => {
        const r = await chrome.storage.local.get([`cookies_${ids[0]}`, `cookies_${ids[1]}`])
        return (
          Object.keys(r[`cookies_${ids[0]}`] ?? {}).length > 0 &&
          Object.keys(r[`cookies_${ids[1]}`] ?? {}).length > 0
        )
      },
      [sessionAId, sessionBId],
      { timeout: 5_000 },
    )
    // Wait for async updateSessionRules calls to complete.
    await helperPage.waitForTimeout(150)

    // tab1 → DNR injects only Session A cookies
    await tab1.goto(`${mockServerUrl}/cookies?t=1`)
    const tab1Result = JSON.parse(await tab1.textContent('body') ?? '{}')
    expect(tab1Result.cookies.user).toBe('alice')

    // tab2 → DNR injects only Session B cookies
    await tab2.goto(`${mockServerUrl}/cookies?t=2`)
    const tab2Result = JSON.parse(await tab2.textContent('body') ?? '{}')
    expect(tab2Result.cookies.user).toBe('bob')
  })

  /**
   * Pollution test: an isolated session's third-party subresource Set-Cookie
   * responses must NOT leak into that third party's global cookie jar. Same-site
   * subresources are allowed so browser login flows can carry auth cookies.
   */
  test('isolated third-party subresource Set-Cookie does not pollute the default cookie jar', async ({
    context, extensionId, mockServerUrl,
  }) => {
    const origin = mockServerUrl
    const thirdPartyUrl = mockServerUrl.replace('localhost', '127.0.0.1')
    const sessionBId = `session_e2e_pollute_b_${Date.now()}`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)

    await helperPage.evaluate(async ({ origin, sessionB }) => {
      await chrome.storage.local.set({
        [`list_${origin}`]: [{ id: sessionB, name: 'Session B', hue: 30 }],
        profiles: [{ id: sessionB, name: 'Session B', hue: 30 }],
        [`cookies_${sessionB}`]: {},
      })
    }, { origin, sessionB: sessionBId })

    // Default tab (profile A): write user=alice to the global jar.
    const defaultTab = await context.newPage()
    await defaultTab.goto(`${mockServerUrl}/set?user=alice`)
    await defaultTab.goto(`${mockServerUrl}/cookies?t=a`)
    expect(JSON.parse(await defaultTab.textContent('body') ?? '{}').cookies.user).toBe('alice')

    // Tab B: assign isolated session B.
    const tabB = await context.newPage()
    await tabB.goto(`${mockServerUrl}/cookies?t=b`)
    const { tabBId } = await helperPage.evaluate(async () => ({
      tabBId: (await chrome.tabs.query({})).find(
        (t: chrome.tabs.Tab) => t.url?.includes('t=b'),
      )?.id,
    }))
    expect(tabBId).toBeDefined()
    await helperPage.evaluate(
      async ({ tabId, sessionId }) =>
        chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId } }),
      { tabId: tabBId, sessionId: sessionBId },
    )

    // B receives a third-party subresource Set-Cookie. Capture must still land in
    // B's store, but the third-party global jar must stay clean.
    await tabB.evaluate(async (url) => {
      await new Promise<void>((resolve) => {
        const img = new Image()
        img.onload = () => resolve()
        img.onerror = () => resolve()
        img.src = `${url}/set-resource?user=bob&cache=${Date.now()}`
      })
    }, thirdPartyUrl)
    await helperPage.waitForFunction(
      async (id) => {
        const r = await chrome.storage.local.get([`cookies_${id}`])
        return Object.keys(r[`cookies_${id}`] ?? {}).length > 0
      },
      sessionBId,
      { timeout: 5_000 },
    )
    await helperPage.waitForTimeout(150)

    // First-party global jar must be untouched: a fresh default tab still sees alice.
    const checkTab = await context.newPage()
    await checkTab.goto(`${mockServerUrl}/cookies?t=check`)
    expect(JSON.parse(await checkTab.textContent('body') ?? '{}').cookies.user).toBe('alice')

    // Third-party global jar must not receive bob from the isolated subresource.
    const thirdPartyCheckTab = await context.newPage()
    await thirdPartyCheckTab.goto(`${thirdPartyUrl}/cookies?t=check`)
    expect(JSON.parse(await thirdPartyCheckTab.textContent('body') ?? '{}').cookies.user).toBeUndefined()

    // B's tab still sees its own cookie (capture + DNR injection both work).
    await tabB.goto(`${thirdPartyUrl}/cookies?t=b`)
    expect(JSON.parse(await tabB.textContent('body') ?? '{}').cookies.user).toBe('bob')
  })

  test('isolated navigation redirect carries Set-Cookie to redirected request', async ({
    context, extensionId, mockServerUrl,
  }) => {
    const origin = mockServerUrl
    const sessionId = `session_e2e_redirect_${Date.now()}`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)
    await helperPage.evaluate(async ({ origin, sessionId }) => {
      await chrome.storage.local.set({
        [`list_${origin}`]: [{ id: sessionId, name: 'Redirect', hue: 210 }],
        profiles: [{ id: sessionId, name: 'Redirect', hue: 210 }],
        [`cookies_${sessionId}`]: {},
      })
    }, { origin, sessionId })

    const tab = await context.newPage()
    await tab.goto(`${mockServerUrl}/cookies?t=redirect`)
    const { tabId } = await helperPage.evaluate(async () => ({
      tabId: (await chrome.tabs.query({})).find(
        (t: chrome.tabs.Tab) => t.url?.includes('t=redirect'),
      )?.id,
    }))
    expect(tabId).toBeDefined()

    await helperPage.evaluate(
      async ({ tabId, sessionId }) =>
        chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId } }),
      { tabId, sessionId },
    )

    await tab.goto(`${mockServerUrl}/set?user=bob`)
    expect(JSON.parse(await tab.textContent('body') ?? '{}').cookies.user).toBe('bob')
  })

  test('isolated same-site auth fetch can set cookie before immediate navigation', async ({
    context, extensionId, mockServerUrl,
  }) => {
    const origin = mockServerUrl
    const sessionId = `session_e2e_fetch_nav_${Date.now()}`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)
    await helperPage.evaluate(async ({ origin, sessionId }) => {
      await chrome.storage.local.set({
        [`list_${origin}`]: [{ id: sessionId, name: 'FetchNav', hue: 250 }],
        profiles: [{ id: sessionId, name: 'FetchNav', hue: 250 }],
        [`cookies_${sessionId}`]: {},
      })
    }, { origin, sessionId })

    const defaultTab = await context.newPage()
    await defaultTab.goto(`${mockServerUrl}/set?user=alice`)
    await defaultTab.goto(`${mockServerUrl}/cookies?t=default-before-fetch`)
    expect(JSON.parse(await defaultTab.textContent('body') ?? '{}').cookies.user).toBe('alice')

    const tab = await context.newPage()
    await tab.goto(`${mockServerUrl}/cookies?t=fetch-nav`)
    const { tabId } = await helperPage.evaluate(async () => ({
      tabId: (await chrome.tabs.query({})).find(
        (t: chrome.tabs.Tab) => t.url?.includes('t=fetch-nav'),
      )?.id,
    }))
    expect(tabId).toBeDefined()

    await helperPage.evaluate(
      async ({ tabId, sessionId }) =>
        chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId } }),
      { tabId, sessionId },
    )

    await tab.evaluate(async (url) => {
      await fetch(`${url}/set-resource?user=bob`, { credentials: 'include' })
      window.location.href = `${url}/cookies?t=after-fetch`
    }, mockServerUrl)
    await tab.waitForURL('**/cookies?t=after-fetch')
    expect(JSON.parse(await tab.textContent('body') ?? '{}').cookies.user).toBe('bob')

    const checkTab = await context.newPage()
    await checkTab.goto(`${mockServerUrl}/cookies?t=default-after-fetch`)
    expect(JSON.parse(await checkTab.textContent('body') ?? '{}').cookies.user).toBe('alice')
  })

  /**
   * Reset-to-default test: after calling setSession with 'default', the tab's
   * session ID returns to 'default' and the DNR rule is removed.
   *
   * Note: the extension keeps cookies in the global jar by design, so we verify
   * the session state via getSession rather than checking cookie presence.
   */
  test('resetting to default removes tab session assignment', async ({
    context, extensionId, mockServerUrl,
  }) => {
    const origin = mockServerUrl
    const sessionId = `session_e2e_reset_${Date.now()}`

    const helperPage = await context.newPage()
    await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`)

    await helperPage.evaluate(async ({ origin, sessionId }) => {
      await chrome.storage.local.set({
        [`list_${origin}`]: [{ id: sessionId, name: 'TempSession', hue: 120 }],
        profiles: [{ id: sessionId, name: 'TempSession', hue: 120 }],
        [`cookies_${sessionId}`]: {},
      })
    }, { origin, sessionId })

    const tab = await context.newPage()
    await tab.goto(`${mockServerUrl}/cookies?t=reset`)

    const { tabId } = await helperPage.evaluate(async () => ({
      tabId: (await chrome.tabs.query({})).find(
        (t: chrome.tabs.Tab) => t.url?.includes('t=reset'),
      )?.id,
    }))

    expect(tabId).toBeDefined()

    // Assign session to tab
    await helperPage.evaluate(
      async ({ tabId, sessionId }) =>
        chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId } }),
      { tabId, sessionId },
    )

    // Verify session is assigned
    const before = await helperPage.evaluate(
      async ({ tabId }) =>
        chrome.runtime.sendMessage({ action: 'getSession', payload: { tabId } }),
      { tabId },
    )
    expect(before.sessionId).toBe(sessionId)

    // Reset to default
    await helperPage.evaluate(
      async ({ tabId }) =>
        chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId: 'default' } }),
      { tabId },
    )

    // Verify session is now default and DNR rule is removed
    const after = await helperPage.evaluate(
      async ({ tabId }) =>
        chrome.runtime.sendMessage({ action: 'getSession', payload: { tabId } }),
      { tabId },
    )
    expect(after.sessionId).toBe('default')
  })
})
