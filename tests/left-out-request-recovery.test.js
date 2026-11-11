import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleHeadersReceived, handleRequestCompleted } from '../background/dnr-manager.js'
import { noteRequestStarted, refreshRulesBeforeNavigation } from '../background/left-out-request-recovery.js'
import { updateDNRRulesForTab } from '../background/dnr-tab-rule-publisher.js'
import { resolveHeldRedirect } from '../background/held-redirects.js'
import { tabSessions } from '../background/session-manager.js'
import { getCookieStore } from '../lib/session-store.js'
import { cookieKey } from '../lib/cookie-parser.js'

// A well-used profile holds more sites than a tab has rules. A site the tab's
// rules leave out is reached with no cookies at all; the server answers a
// stranger, and capturing that answer would overwrite the profile's login.
//
// Events are driven in the order Chrome delivers them: onBeforeRequest (rules
// are matched here), onHeadersReceived, onCompleted.

const BANK = 'bank.example'
const ACCOUNT = `https://${BANK}/account`
const SESSION = 's_big'
const updateSessionRules = () => chrome.declarativeNetRequest.updateSessionRules

const hostCookie = (name, value, host, path = '/') => ({ name, value, domain: host, path, expires: null })

function bigStore() {
  const store = { [cookieKey('login', BANK, '/')]: hostCookie('login', 'alice', BANK) }
  // 110 hosts sorting before bank.example: its scope does not fit the tab's rules.
  for (let i = 0; i < 110; i++) {
    const host = `a${String(i).padStart(3, '0')}.example`
    store[cookieKey('sid', host, '/')] = hostCookie('sid', 'x', host)
  }
  return store
}

const bankCookieRule = () => updateSessionRules().mock.calls.at(-1)?.[0].addRules
  .find((rule) => rule.action.requestHeaders?.[0]?.value === 'login=alice')
const storedLogin = async () => (await getCookieStore(SESSION))[cookieKey('login', BANK, '/')]?.value
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const later = () => Date.now() + 1000

let tabId = 500
// Chrome never reuses a request id; each test gets its own.
let requestId = 'req-0'

async function seed(store = bigStore()) {
  await chrome.storage.local.set({
    profiles: [{ id: SESSION, name: 'Big', hue: 0 }],
    [`cookies_${SESSION}`]: store,
  })
}

beforeEach(async () => {
  tabId += 1
  requestId = `req-${tabId}`
  for (const key of Object.keys(tabSessions)) delete tabSessions[key]
  tabSessions[tabId] = SESSION
  await seed()
  chrome.tabs.get.mockReset()
  chrome.tabs.get.mockResolvedValue({ id: tabId, url: 'https://a000.example/' })
  chrome.tabs.reload.mockClear()
  chrome.tabs.update.mockReset()
  chrome.tabs.update.mockResolvedValue({})
  updateSessionRules().mockReset()
  updateSessionRules().mockResolvedValue({})
})

/** The tab's rules are known to this worker and leave bank.example out. */
async function publishRulesThatLeaveBankOut() {
  await updateDNRRulesForTab(tabId, SESSION)
  expect(bankCookieRule()).toBeUndefined()
  updateSessionRules().mockClear()
}

const request = (overrides = {}) => ({
  requestId, tabId, frameId: 0, type: 'main_frame', method: 'GET', url: ACCOUNT, documentLifecycle: 'active', ...overrides,
})
const start = (overrides = {}) => noteRequestStarted({ timeStamp: later(), ...request(overrides) })
const respond = (overrides = {}) => handleHeadersReceived({
  statusCode: 200, responseHeaders: [{ name: 'Set-Cookie', value: 'login=guest; Path=/' }], ...request(overrides),
})
const finish = (overrides = {}) => handleRequestCompleted(request(overrides))

describe('a request to a site the tab\'s rules leave out', () => {
  beforeEach(publishRulesThatLeaveBankOut)

  it('keeps the profile\'s login: the guest cookie answering the bare request is not captured', async () => {
    start()
    await respond()

    expect(await storedLogin()).toBe('alice')
  })

  it('rebuilds the rules with the site first and requests the same URL again', async () => {
    start()
    await flush()

    expect(bankCookieRule()).toBeDefined()
    // The bare URL itself, not whatever redirect the bare request ended on.
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabId, { url: ACCOUNT })
    expect(chrome.tabs.reload).not.toHaveBeenCalled()
  })

  it('keeps the fragment of the navigation it requests again', async () => {
    chrome.tabs.get.mockResolvedValue({ id: tabId, url: 'https://a000.example/', pendingUrl: `${ACCOUNT}#/transfers` })
    start()
    await flush()

    expect(chrome.tabs.update).toHaveBeenCalledWith(tabId, { url: `${ACCOUNT}#/transfers` })
  })

  it('reloads the replay past the cache only when the cache answered it', async () => {
    start()
    await flush()
    start({ requestId: 'replay-live' })
    await finish({ requestId: 'replay-live', fromCache: false })
    expect(chrome.tabs.reload).not.toHaveBeenCalled()

    // Same again, but the disk cache answers the replay with the response that
    // was fetched without cookies.
    tabId += 1000
    tabSessions[tabId] = SESSION
    chrome.tabs.get.mockResolvedValue({ id: tabId, url: 'https://a000.example/' })
    await updateDNRRulesForTab(tabId, SESSION)
    start({ requestId: 'bare-2' })
    await flush()
    start({ requestId: 'replay-cached' })
    await finish({ requestId: 'replay-cached', fromCache: true })

    expect(chrome.tabs.reload).toHaveBeenCalledTimes(1)
    expect(chrome.tabs.reload).toHaveBeenCalledWith(tabId, { bypassCache: true })
  })

  it('ignores the rest of the redirect chain: it follows from an answer given to a stranger', async () => {
    start()
    await flush()
    // The rules now cover the site, so this next hop of the same chain carries
    // the login — to a URL the server picked for a stranger, which logs out
    // whoever arrives (WordPress: wp-login.php?reauth=1).
    const reauth = `https://${BANK}/login?reauth=1`
    start({ url: reauth })
    await respond({ url: reauth, responseHeaders: [{ name: 'Set-Cookie', value: 'login=; Path=/; Max-Age=0' }] })

    expect(await storedLogin()).toBe('alice')
    // The chain's first bare URL is what gets requested again, once.
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1)
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabId, { url: ACCOUNT })
  })

  it('does not follow a held redirect of a navigation it requests again', async () => {
    start()
    await respond({
      statusCode: 302,
      responseHeaders: [
        { name: 'Set-Cookie', value: 'login=guest; Path=/' },
        { name: 'Location', value: '/login?reauth=1' },
      ],
    })
    await flush()

    expect(await resolveHeldRedirect(tabId, 0)).toBeNull()
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabId, { url: ACCOUNT })
  })

  it('trusts the request sent again: its response is captured, and nothing loops', async () => {
    start()
    await flush()
    await finish()

    start({ requestId: 'again' })
    await respond({ requestId: 'again', responseHeaders: [{ name: 'Set-Cookie', value: 'login=alice2; Path=/' }] })
    await flush()

    expect(await storedLogin()).toBe('alice2')
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1)
  })

  it('covers a third-party subresource without touching the page', async () => {
    start({ type: 'xmlhttprequest', url: `https://${BANK}/api/me` })
    await respond({ type: 'xmlhttprequest', url: `https://${BANK}/api/me` })
    await flush()

    expect(chrome.tabs.update).not.toHaveBeenCalled()
    expect(bankCookieRule()).toBeDefined()
    expect(await storedLogin()).toBe('alice')
  })

  it('leaves requests to covered sites alone', async () => {
    start({ url: 'https://a000.example/next' })
    await respond({ url: 'https://a000.example/next', responseHeaders: [{ name: 'Set-Cookie', value: 'sid=fresh; Path=/' }] })

    expect(updateSessionRules()).toHaveBeenCalledTimes(1) // the capture's own publish
    expect(chrome.tabs.update).not.toHaveBeenCalled()
    expect((await getCookieStore(SESSION))[cookieKey('sid', 'a000.example', '/')].value).toBe('fresh')
  })

  it('publishes once for a burst of requests to the same left-out site', async () => {
    for (let i = 0; i < 5; i++) start({ requestId: `burst-${i}`, type: 'image', url: `https://${BANK}/pixel-${i}.gif` })
    await flush()

    expect(updateSessionRules()).toHaveBeenCalledTimes(1)
  })
})

describe('a POST to a site the tab\'s rules leave out', () => {
  beforeEach(publishRulesThatLeaveBankOut)

  it('is never replayed, and nothing its redirect chain sets is kept', async () => {
    start({ method: 'POST' })
    await flush()
    // The rules cover the site by now. The server redirected the stranger to a
    // page that logs out whoever arrives; that hop carries the login.
    const reauth = `https://${BANK}/login?reauth=1`
    start({ method: 'GET', url: reauth })
    await respond({ url: reauth, responseHeaders: [{ name: 'Set-Cookie', value: 'login=; Path=/; Max-Age=0' }] })
    await flush()

    expect(chrome.tabs.update).not.toHaveBeenCalled()
    expect(await storedLogin()).toBe('alice')
    // The site is covered for what the user does next.
    expect(bankCookieRule()).toBeDefined()
  })

  it('still follows its held redirect: nothing else would move the tab on', async () => {
    start({ method: 'POST' })
    await respond({
      method: 'POST',
      statusCode: 302,
      responseHeaders: [{ name: 'Set-Cookie', value: 'login=guest; Path=/' }, { name: 'Location', value: '/welcome' }],
    })

    expect(await resolveHeldRedirect(tabId, 0)).toBe(`https://${BANK}/welcome`)
    expect(await storedLogin()).toBe('alice')
  })
})

describe('the replay never moves the tab somewhere the user did not choose', () => {
  beforeEach(publishRulesThatLeaveBankOut)

  it('a prerendered page shares the tab\'s id but is not the page the user sees: never replayed', async () => {
    start({ frameId: 7, documentLifecycle: 'prerender' })
    await respond({ frameId: 7, documentLifecycle: 'prerender' })
    await flush()

    expect(chrome.tabs.update).not.toHaveBeenCalled()
    expect(await storedLogin()).toBe('alice')
  })

  it('a navigation the user has already left is not requested again', async () => {
    start()
    // Before the rebuilt rules are live, the user navigates elsewhere.
    start({ requestId: 'elsewhere', url: 'https://a001.example/' })
    await flush()

    expect(chrome.tabs.update).not.toHaveBeenCalled()
  })

  it('of two bare navigations in a row, only the later one is requested again', async () => {
    start()
    start({ requestId: 'second', url: `https://${BANK}/statements` })
    await flush()

    expect(chrome.tabs.update).toHaveBeenCalledTimes(1)
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabId, { url: `https://${BANK}/statements` })
  })
})

describe('a site whose cookies cannot fit even in first place', () => {
  const DEEP = `https://${BANK}/area119/page`

  beforeEach(async () => {
    // One site with more cookie paths than the tab has rules.
    const store = { [cookieKey('login', BANK, '/')]: hostCookie('login', 'alice', BANK) }
    for (let i = 0; i < 120; i++) {
      const path = `/area${String(i).padStart(3, '0')}`
      store[cookieKey('pref', BANK, path)] = hostCookie('pref', 'x', BANK, path)
    }
    await seed(store)
    chrome.tabs.get.mockResolvedValue({ id: tabId, url: `https://${BANK}/` })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await updateDNRRulesForTab(tabId, SESSION)
    updateSessionRules().mockClear()
  })

  it('never captures the answer to a request that left cookies behind, even on the tab\'s own site', async () => {
    start({ url: DEEP })
    await respond({ url: DEEP })

    expect(await storedLogin()).toBe('alice')
  })

  it('does not request the page again when that would leave it just as bare, nor publish in a loop', async () => {
    start({ url: DEEP })
    await flush()
    expect(updateSessionRules()).toHaveBeenCalledTimes(1)
    expect(chrome.tabs.update).not.toHaveBeenCalled()

    // Every later request to it changes nothing in the rules: no further publish.
    start({ requestId: 'deep-2', url: DEEP })
    start({ requestId: 'deep-3', type: 'image', url: `${DEEP}/pixel.gif` })
    await flush()
    expect(updateSessionRules()).toHaveBeenCalledTimes(1)
    expect(chrome.tabs.update).not.toHaveBeenCalled()
  })
})

describe('when the rules cannot be rebuilt', () => {
  beforeEach(publishRulesThatLeaveBankOut)

  it('says so, requests nothing again, and lets the held redirect move the tab on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    updateSessionRules().mockRejectedValue(new Error('nope'))

    start()
    await respond({
      statusCode: 302,
      responseHeaders: [{ name: 'Set-Cookie', value: 'login=guest; Path=/' }, { name: 'Location', value: '/login' }],
    })
    await flush()

    expect(error.mock.calls.some(([message]) => /covering bank\.example for tab/.test(message))).toBe(true)
    expect(chrome.tabs.update).not.toHaveBeenCalled()
    expect(await resolveHeldRedirect(tabId, 0)).toBe(`https://${BANK}/login`)
    expect(await storedLogin()).toBe('alice')
    error.mockRestore()
  })
})

// Chrome stops an idle service worker after 30 seconds. The rules stay live in
// Chrome, but the restarted worker remembers neither what they cover nor, at
// first, which tabs belong to a profile — and the click that wakes it is the
// request that needs that knowledge. Nothing has been published by this worker
// when these requests start.
describe('a restarted service worker', () => {
  it('judges the request that woke it: started before the worker knew the tab\'s rules', async () => {
    start({ timeStamp: Date.now() })
    await respond()
    await flush()

    expect(await storedLogin()).toBe('alice')
    expect(bankCookieRule()).toBeDefined()
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabId, { url: ACCOUNT })
  })

  it('judges a request that started before the worker knew the tab belongs to a profile', async () => {
    delete tabSessions[tabId]
    start({ timeStamp: Date.now() })
    tabSessions[tabId] = SESSION // restored from chrome.storage.session meanwhile

    await respond()

    expect(await storedLogin()).toBe('alice')
  })

  it('judges a request whose start it never saw', async () => {
    await respond()

    expect(await storedLogin()).toBe('alice')
  })

  it('still captures the answer to a request its rules did cover', async () => {
    const url = 'https://a000.example/next'
    start({ url, timeStamp: Date.now() })
    await respond({ url, responseHeaders: [{ name: 'Set-Cookie', value: 'sid=fresh; Path=/' }] })

    expect((await getCookieStore(SESSION))[cookieKey('sid', 'a000.example', '/')].value).toBe('fresh')
    expect(chrome.tabs.update).not.toHaveBeenCalled()
  })
})

describe('a request that finishes while its capture is still being decided', () => {
  it('leaves no state behind once both are done', async () => {
    const { isDistrustedChain, isHopJudged } = await import('../background/tab-cookie-rule-coverage.js')
    // Restarted worker: the response is judged inside its capture, and Chrome
    // reports the request complete before that judgment has happened.
    const capture = respond()
    const completed = finish()
    await Promise.all([capture, completed])

    expect(await storedLogin()).toBe('alice')
    expect(isDistrustedChain(requestId)).toBe(false)
    expect(isHopJudged(requestId, ACCOUNT)).toBe(false)
  })
})

describe('refreshRulesBeforeNavigation', () => {
  it('rebuilds the rules with the site being navigated to first when they leave it out', async () => {
    await publishRulesThatLeaveBankOut()

    await refreshRulesBeforeNavigation(tabId, ACCOUNT)

    expect(bankCookieRule()).toBeDefined()
    // The request that follows is covered: captured, nothing to recover.
    start()
    await respond({ responseHeaders: [{ name: 'Set-Cookie', value: 'login=alice2; Path=/' }] })
    expect(await storedLogin()).toBe('alice2')
    expect(chrome.tabs.update).not.toHaveBeenCalled()
  })

  it('a request that started just before those rules went live is requested again', async () => {
    await publishRulesThatLeaveBankOut()
    const startedBefore = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 5))

    await refreshRulesBeforeNavigation(tabId, ACCOUNT)
    // The rebuild is finished by the time the worker hears of the request.
    start({ timeStamp: startedBefore })
    await respond()
    await flush()

    expect(await storedLogin()).toBe('alice')
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabId, { url: ACCOUNT })
  })

  it('publishes for where the tab is heading when this worker does not know the tab\'s rules', async () => {
    await refreshRulesBeforeNavigation(tabId, ACCOUNT)

    expect(updateSessionRules()).toHaveBeenCalledTimes(1)
    expect(bankCookieRule()).toBeDefined()
  })

  it('does nothing when the site is already covered, the URL is not a web URL, or the tab has no profile', async () => {
    await publishRulesThatLeaveBankOut()

    await refreshRulesBeforeNavigation(tabId, 'https://a000.example/next')
    await refreshRulesBeforeNavigation(tabId, 'chrome://settings/')
    delete tabSessions[tabId]
    await refreshRulesBeforeNavigation(tabId, ACCOUNT)

    expect(updateSessionRules()).not.toHaveBeenCalled()
  })
})
