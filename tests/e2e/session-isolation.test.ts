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

    // Set cookies via mock server — webRequest listener captures Set-Cookie
    // and stores per session; DNR rule is updated after 50ms debounce
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
    // Wait for DNR debounce (50ms) + async updateSessionRules to complete
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
