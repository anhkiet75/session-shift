import { describe, it, expect } from 'vitest'
import { handleMessage } from '../background.js'
import { handleRequestCompleted } from '../background/dnr-manager.js'
import { tabSessions } from '../background/session-manager.js'

const SENDER = { id: chrome.runtime.id }

function findCookieEntryByName(store, name) {
  return Object.values(store).find((entry) => entry?.name === name) ?? store[name]
}

function tabSender(tabId, url) {
  return { id: chrome.runtime.id, tab: { id: tabId, url } }
}

describe('getSessionForBootstrap', () => {
  it('returns default + empty cookieStr for unknown tab', async () => {
    const result = await handleMessage(
      { action: 'getSessionForBootstrap', payload: { tabId: 9999 } },
      SENDER
    )
    expect(result.sessionId).toBe('default')
    expect(result.cookieStr).toBe('')
  })

  it('returns sessionId + cookie string for an active session', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_boot1', name: 'Boot', hue: 212 }],
      'cookies_session_boot1': { tok: { value: 'abc', expires: null } },
    })
    await handleMessage(
      { action: 'setSession', payload: { tabId: 55, sessionId: 'session_boot1' } },
      SENDER
    )
    const result = await handleMessage(
      { action: 'getSessionForBootstrap', payload: { tabId: 55 } },
      SENDER
    )
    expect(result.sessionId).toBe('session_boot1')
    expect(result.cookieStr).toContain('tok=abc')
  })
})

describe('refreshBadge', () => {
  it('returns success for valid tabId', async () => {
    const result = await handleMessage(
      { action: 'refreshBadge', payload: { tabId: 1 } },
      SENDER
    )
    expect(result.success).toBe(true)
  })

  it('returns error for non-numeric tabId', async () => {
    const result = await handleMessage(
      { action: 'refreshBadge', payload: { tabId: 'bad' } },
      SENDER
    )
    expect(result.error).toBeTruthy()
  })

  it('returns error when tabId is missing', async () => {
    const result = await handleMessage(
      { action: 'refreshBadge', payload: {} },
      SENDER
    )
    expect(result.error).toBeTruthy()
  })
})

describe('duplicateSession via handleMessage', () => {
  it('returns error for non-string sessionId', async () => {
    const result = await handleMessage(
      { action: 'duplicateSession', payload: { sessionId: 123 } },
      SENDER
    )
    expect(result.error).toBeTruthy()
  })

  it('creates duplicate via message handler', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_d1', name: 'Orig', hue: 158 }],
      'cookies_session_d1': { c: { value: '1', expires: null } },
    })
    const result = await handleMessage(
      { action: 'duplicateSession', payload: { sessionId: 'session_d1' } },
      SENDER
    )
    expect(result.success).toBe(true)
    expect(result.session.name).toBe('Orig (copy)')
  })
})

describe('createSessionTab — new profile must not leak the default jar cookie', () => {
  it('rejects unknown session ids before creating a tab', async () => {
    await chrome.storage.local.set({ profiles: [{ id: 'session_known', name: 'Known', hue: 0 }] })

    const result = await handleMessage(
      { action: 'createSessionTab', payload: { url: 'https://example.com/dashboard', sessionId: 'session_does_not_exist' } },
      SENDER
    )

    expect(result).toEqual({ error: 'unknown session' })
    expect(chrome.tabs.create).not.toHaveBeenCalled()
  })

  it('strips Cookie on the first navigation, then clears the strip once that navigation completes', async () => {
    await chrome.storage.local.set({ profiles: [{ id: 'session_new1', name: 'New', hue: 0 }] })
    chrome.tabs.create.mockResolvedValue({ id: 401 })
    chrome.tabs.get.mockResolvedValue({ id: 401, url: 'https://example.com/dashboard' })
    chrome.declarativeNetRequest.updateSessionRules.mockClear()

    const result = await handleMessage(
      { action: 'createSessionTab', payload: { url: 'https://example.com/dashboard', sessionId: 'session_new1' } },
      SENDER
    )
    expect(result.success).toBe(true)

    // The very first DNR publish must strip Cookie on a main_frame/sub_frame
    // navigation to that exact host — otherwise Chrome attaches the default
    // jar's stale cookie and the brand-new profile looks logged in already.
    let calls = chrome.declarativeNetRequest.updateSessionRules.mock.calls
    let { addRules } = calls[calls.length - 1][0]
    const stripRule = addRules.find(r =>
      r.action.requestHeaders?.some(h => h.header === 'Cookie' && h.operation === 'remove') &&
      r.condition.resourceTypes?.includes('main_frame')
    )
    expect(stripRule).toBeDefined()

    // Once the navigation to that host completes, the strip must be cleared so
    // later navigations in this tab are not permanently cookie-less.
    await handleRequestCompleted({ requestId: 'nav-1', tabId: 401, type: 'main_frame' })
    calls = chrome.declarativeNetRequest.updateSessionRules.mock.calls
    ;({ addRules } = calls[calls.length - 1][0])
    const strippedAfter = addRules.find(r =>
      r.action.requestHeaders?.some(h => h.header === 'Cookie' && h.operation === 'remove') &&
      r.condition.resourceTypes?.includes('main_frame')
    )
    expect(strippedAfter).toBeUndefined()

    delete tabSessions[401]
  })
})

describe('setSession — switching an open tab to a profile', () => {
  it('does not strip when switching back to default', async () => {
    chrome.tabs.get.mockResolvedValue({ id: 403, url: 'https://example.org/account' })
    chrome.declarativeNetRequest.updateSessionRules.mockClear()

    await handleMessage(
      { action: 'setSession', payload: { tabId: 403, sessionId: 'default' } },
      SENDER
    )

    const calls = chrome.declarativeNetRequest.updateSessionRules.mock.calls
    const { addRules } = calls[calls.length - 1][0]
    expect(addRules.length).toBe(0)

    delete tabSessions[403]
  })
})

describe('unknown action', () => {
  it('returns error for unknown action', async () => {
    const result = await handleMessage(
      { action: 'doesNotExist', payload: {} },
      SENDER
    )
    expect(result.error).toMatch(/unknown action/)
  })
})

describe('updateCookie trust boundary (H3)', () => {
  it('returns error when sender has no tab context', async () => {
    const result = await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: 'a=1' } },
      SENDER
    )
    expect(result.error).toBe('no tab context')
  })

  it('merges new cookies without wiping existing ones', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_m1', name: 'M', hue: 0 }],
      'cookies_session_m1': { existing: { value: 'old', expires: null } },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 200, sessionId: 'session_m1' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: 'newcookie=val' } },
      tabSender(200, 'https://merge.com/page')
    )
    const stored = await chrome.storage.local.get(['cookies_session_m1'])
    expect(stored['cookies_session_m1'].existing.value).toBe('old')
    expect(findCookieEntryByName(stored['cookies_session_m1'], 'newcookie')?.value).toBe('val')
  })

  it('empty cookieStr does not wipe existing cookies', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_w1', name: 'W', hue: 0 }],
      'cookies_session_w1': { precious: { value: 'keep', expires: null } },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 201, sessionId: 'session_w1' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: '' } },
      tabSender(201, 'https://wipe.com/page')
    )
    const stored = await chrome.storage.local.get(['cookies_session_w1'])
    expect(stored['cookies_session_w1'].precious.value).toBe('keep')
  })

  it('deletedNames removes the named cookie', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_del1', name: 'D', hue: 0 }],
      'cookies_session_del1': {
        gone:  { value: 'bye', expires: null },
        stays: { value: 'hi',  expires: null },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 202, sessionId: 'session_del1' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: '', deletedNames: ['gone'] } },
      tabSender(202, 'https://del.com/page')
    )
    const stored = await chrome.storage.local.get(['cookies_session_del1'])
    expect(findCookieEntryByName(stored['cookies_session_del1'], 'gone')).toBeUndefined()
    expect(stored['cookies_session_del1'].stays.value).toBe('hi')
  })

  it('cannot overwrite a server-set httpOnly cookie via document.cookie path', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_hp1', name: 'HP', hue: 0 }],
      'cookies_session_hp1': { secret: { value: 'original', expires: null, httpOnly: true } },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 203, sessionId: 'session_hp1' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: 'secret=hacked' } },
      tabSender(203, 'https://hp.com/page')
    )
    const stored = await chrome.storage.local.get(['cookies_session_hp1'])
    expect(findCookieEntryByName(stored['cookies_session_hp1'], 'secret')?.value).toBe('original')
  })

  it('stores document.cookie writes under the current document host and default path', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_doc_host', name: 'Doc', hue: 0 }],
      'cookies_session_doc_host': {},
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 205, sessionId: 'session_doc_host' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: 'jsid=val' } },
      tabSender(205, 'https://accounts.google.com/login/callback')
    )

    const stored = await chrome.storage.local.get(['cookies_session_doc_host'])
    expect(stored['cookies_session_doc_host']['jsid|accounts.google.com|/login']?.value).toBe('val')
    expect(stored['cookies_session_doc_host']['jsid|www.google.com|/']).toBeUndefined()
  })

  it('deletedNames only removes cookies matching the current document URL', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_doc_delete', name: 'Doc', hue: 0 }],
      'cookies_session_doc_delete': {
        'sid|accounts.google.com|/login': {
          name: 'sid',
          value: 'accounts',
          domain: 'accounts.google.com',
          path: '/login',
          expires: null,
        },
        'sid|www.google.com|/': {
          name: 'sid',
          value: 'www',
          domain: 'www.google.com',
          path: '/',
          expires: null,
        },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 206, sessionId: 'session_doc_delete' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: '', deletedNames: ['sid'] } },
      tabSender(206, 'https://accounts.google.com/login/callback')
    )

    const stored = await chrome.storage.local.get(['cookies_session_doc_delete'])
    expect(stored['cookies_session_doc_delete']['sid|accounts.google.com|/login']).toBeUndefined()
    expect(stored['cookies_session_doc_delete']['sid|www.google.com|/']?.value).toBe('www')
  })
})

describe('updateCookie setCookieStr — attributes + injection guard (Phase 1)', () => {
  it('host-pins the domain and ignores a page-supplied Domain (no injection)', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_pin', name: 'Pin', hue: 0 }],
      'cookies_session_pin': {},
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 300, sessionId: 'session_pin' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { setCookieStr: 'sid=v; Domain=.evil.com; Path=/a; Max-Age=3600' } },
      tabSender(300, 'https://app.example.com/a/page')
    )
    const store = (await chrome.storage.local.get(['cookies_session_pin']))['cookies_session_pin']
    // Domain host-pinned to the document host; page-supplied .evil.com NOT used.
    expect(store['sid|app.example.com|/a']?.value).toBe('v')
    expect(JSON.stringify(store)).not.toContain('evil')
    expect(store['sid|app.example.com|/a']?.expires).toBeGreaterThan(Date.now())
  })

  it('rejects a forged setCookieStr with a CRLF-injected value', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_crlf', name: 'C', hue: 0 }],
      'cookies_session_crlf': {},
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 301, sessionId: 'session_crlf' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { setCookieStr: 'sid=good\r\nevil=1' } },
      tabSender(301, 'https://app2.example.com/')
    )
    const store = (await chrome.storage.local.get(['cookies_session_crlf']))['cookies_session_crlf']
    expect(Object.keys(store).length).toBe(0)
  })

  it('cookieStore.delete structured target removes by name+path, not document URL', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_sd', name: 'SD', hue: 0 }],
      'cookies_session_sd': {
        'sid|app3.example.com|/admin': { name: 'sid', value: 'a', domain: 'app3.example.com', path: '/admin', expires: null },
        'sid|app3.example.com|/':      { name: 'sid', value: 'r', domain: 'app3.example.com', path: '/', expires: null },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 302, sessionId: 'session_sd' } }, SENDER)
    // Page is at /app but deletes the /admin-scoped cookie via structured target.
    await handleMessage(
      { action: 'updateCookie', payload: { deleteTargets: [{ name: 'sid', path: '/admin' }] } },
      tabSender(302, 'https://app3.example.com/app')
    )
    const store = (await chrome.storage.local.get(['cookies_session_sd']))['cookies_session_sd']
    expect(store['sid|app3.example.com|/admin']).toBeUndefined()
    expect(store['sid|app3.example.com|/']?.value).toBe('r')
  })

  it('setCookieStr cannot overwrite a server-set httpOnly cookie', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_ho', name: 'HO', hue: 0 }],
      'cookies_session_ho': { 'secret|app4.example.com|/': { name: 'secret', value: 'orig', domain: 'app4.example.com', path: '/', expires: null, httpOnly: true } },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 303, sessionId: 'session_ho' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { setCookieStr: 'secret=hacked' } },
      tabSender(303, 'https://app4.example.com/')
    )
    const store = (await chrome.storage.local.get(['cookies_session_ho']))['cookies_session_ho']
    expect(store['secret|app4.example.com|/']?.value).toBe('orig')
  })
})

describe('getSessionForBootstrap httpOnly filtering (H1)', () => {
  it('excludes httpOnly cookies from the bootstrap cookie string', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_b2', name: 'B2', hue: 0 }],
      'cookies_session_b2': {
        visible: { value: 'show', expires: null, httpOnly: false },
        hidden:  { value: 'hide', expires: null, httpOnly: true },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 204, sessionId: 'session_b2' } }, SENDER)
    const result = await handleMessage(
      { action: 'getSessionForBootstrap', payload: { tabId: 204 } },
      SENDER
    )
    expect(result.cookieStr).toContain('visible=show')
    expect(result.cookieStr).not.toContain('hidden=hide')
  })
})

describe('getSession', () => {
  it('returns default for tab with no session', async () => {
    const result = await handleMessage(
      { action: 'getSession', payload: { tabId: 8888 } },
      SENDER
    )
    expect(result.sessionId).toBe('default')
  })
})
