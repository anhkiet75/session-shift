import { describe, it, expect } from 'vitest'
import { handleMessage } from '../background.js'
import { handleRequestCompleted, updateDNRRulesForTab } from '../background/dnr-manager.js'
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
      'cookies_session_boot1': { tok: { name: 'tok', value: 'abc', domain: 'example.com', path: '/', expires: null } },
    })
    await handleMessage(
      { action: 'setSession', payload: { tabId: 55, sessionId: 'session_boot1' } },
      SENDER
    )
    const result = await handleMessage(
      { action: 'getSessionForBootstrap', payload: { tabId: 55 } },
      { ...SENDER, url: 'https://example.com/app' }
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

  it('publishes a navigation-wide Cookie strip before the tab navigates, and keeps it', async () => {
    await chrome.storage.local.set({ profiles: [{ id: 'session_new1', name: 'New', hue: 0 }] })
    chrome.tabs.create.mockResolvedValue({ id: 401 })
    chrome.tabs.get.mockResolvedValue({ id: 401, url: 'https://example.com/dashboard' })
    chrome.tabs.update.mockClear()
    chrome.declarativeNetRequest.updateSessionRules.mockClear()

    const result = await handleMessage(
      { action: 'createSessionTab', payload: { url: 'https://example.com/dashboard', sessionId: 'session_new1' } },
      SENDER
    )
    expect(result.success).toBe(true)

    // Rules exist before the tab leaves about:blank, so the first request
    // cannot pick up the normal account's cookie from Chrome's own jar.
    const firstPublish = chrome.declarativeNetRequest.updateSessionRules.mock.invocationCallOrder[0]
    const navigate = chrome.tabs.update.mock.invocationCallOrder[0]
    expect(firstPublish).toBeLessThan(navigate)
    const navStrip = (addRules) => addRules.find(r =>
      r.action.requestHeaders?.some(h => h.header === 'Cookie' && h.operation === 'remove') &&
      r.condition.resourceTypes?.includes('main_frame')
    )
    expect(navStrip(chrome.declarativeNetRequest.updateSessionRules.mock.calls[0][0].addRules)).toBeDefined()

    // Completing a navigation no longer lifts the strip: every later
    // navigation stays out of the normal jar too.
    await handleRequestCompleted({ requestId: 'nav-1', tabId: 401, type: 'main_frame' })
    await updateDNRRulesForTab(401, 'session_new1')
    const calls = chrome.declarativeNetRequest.updateSessionRules.mock.calls
    expect(navStrip(calls[calls.length - 1][0].addRules)).toBeDefined()

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
        visible: { name: 'visible', value: 'show', domain: 'example.com', path: '/', expires: null, httpOnly: false },
        hidden:  { name: 'hidden', value: 'hide', domain: 'example.com', path: '/', expires: null, httpOnly: true },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 204, sessionId: 'session_b2' } }, SENDER)
    const result = await handleMessage(
      { action: 'getSessionForBootstrap', payload: { tabId: 204 } },
      { ...SENDER, url: 'https://example.com/' }
    )
    expect(result.cookieStr).toContain('visible=show')
    expect(result.cookieStr).not.toContain('hidden=hide')
  })
})

// Profiles are global jars: a frame's document.cookie must expose only what
// Chrome would expose to that frame's URL, never another site's cookies.
describe('getSessionForBootstrap scopes document.cookie to the frame URL', () => {
  async function bootstrapFor(tabId, sessionId, store, sender) {
    await chrome.storage.local.set({
      profiles: [{ id: sessionId, name: sessionId, hue: 0 }],
      [`cookies_${sessionId}`]: store,
    })
    await handleMessage({ action: 'setSession', payload: { tabId, sessionId } }, SENDER)
    return (await handleMessage({ action: 'getSessionForBootstrap', payload: { tabId } }, { ...SENDER, ...sender })).cookieStr
  }
  const entry = (name, value, domain, extra = {}) => ({ name, value, domain, path: '/', expires: null, ...extra })

  it('hides cookies that belong to another site in the same profile', async () => {
    const cookieStr = await bootstrapFor(210, 'session_scope1', {
      'XSRF-TOKEN|localhost|/': entry('XSRF-TOKEN', 'mine', 'localhost'),
      'XSRF-TOKEN|127.0.0.1|/': entry('XSRF-TOKEN', 'theirs', '127.0.0.1'),
      'secret|127.0.0.1|/': entry('secret', 'hunter2', '127.0.0.1'),
    }, { url: 'http://localhost:8000/admin' })
    expect(cookieStr).toBe('XSRF-TOKEN=mine')
  })

  it('keeps parent-domain cookies and drops Secure cookies on http', async () => {
    const cookieStr = await bootstrapFor(211, 'session_scope2', {
      'shared|.example.com|/': entry('shared', '1', '.example.com'),
      'secure|app.example.com|/': entry('secure', '1', 'app.example.com', { secure: true }),
    }, { url: 'http://app.example.com/' })
    expect(cookieStr).toBe('shared=1')
  })

  it('uses the inherited origin for about:blank frames and hides everything without one', async () => {
    const store = { 'a|example.com|/': entry('a', '1', 'example.com') }
    expect(await bootstrapFor(212, 'session_scope3', store, { url: 'about:blank', origin: 'https://example.com' })).toBe('a=1')
    expect(await bootstrapFor(213, 'session_scope4', store, { url: 'about:blank' })).toBe('')
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

describe('deleteSession favorites cascade', () => {
  it('purges the deleted profile\'s favorites and leaves other profiles\' intact', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_a', name: 'A', hue: 212 }, { id: 'session_b', name: 'B', hue: 24 }],
      favorites: [
        { id: 'fav_1', label: 'A one', url: 'https://a.test/', sessionId: 'session_a', createdAt: 1 },
        { id: 'fav_2', label: 'B one', url: 'https://b.test/', sessionId: 'session_b', createdAt: 2 },
        { id: 'fav_3', label: 'A two', url: 'https://c.test/', sessionId: 'session_a', createdAt: 3 },
      ],
    })

    const result = await handleMessage({ action: 'deleteSession', payload: { sessionId: 'session_a' } }, SENDER)

    expect(result.success).toBe(true)
    const { favorites } = await chrome.storage.local.get(['favorites'])
    expect(favorites.map(f => f.id)).toEqual(['fav_2'])
  })

  it('leaves favorites untouched when the deleted profile owns none', async () => {
    await chrome.storage.local.set({
      favorites: [{ id: 'fav_1', label: 'B one', url: 'https://b.test/', sessionId: 'session_b', createdAt: 1 }],
    })

    await handleMessage({ action: 'deleteSession', payload: { sessionId: 'session_a' } }, SENDER)

    const { favorites } = await chrome.storage.local.get(['favorites'])
    expect(favorites).toHaveLength(1)
  })
})
