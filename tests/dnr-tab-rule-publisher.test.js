import { describe, it, expect, beforeEach, vi } from 'vitest'
import { updateDNRRulesForTab } from '../background/dnr-tab-rule-publisher.js'
import { hasPublishedRules, leftOutSite } from '../background/tab-cookie-rule-coverage.js'
import { cookieKey } from '../lib/cookie-parser.js'

const SITE_HOST = 'blog.example.org'
const updateSessionRules = () => chrome.declarativeNetRequest.updateSessionRules

function cookie(name, host, path = '/', extra = {}) {
  return { name, value: name, domain: host, path, expires: null, ...extra }
}

/** A well-used profile: the site under test plus `others` unrelated hosts that sort before it. */
function wellUsedStore(others = 110) {
  const store = {
    [cookieKey('test_cookie', SITE_HOST, '/')]: cookie('test_cookie', SITE_HOST),
    [cookieKey('auth', SITE_HOST, '/wp-admin')]: cookie('auth', SITE_HOST, '/wp-admin', { secure: true }),
  }
  for (let i = 0; i < others; i++) {
    const host = `a${String(i).padStart(3, '0')}.example`
    store[cookieKey('sid', host, '/')] = cookie('sid', host)
  }
  return store
}

async function seedProfile(sessionId, store) {
  await chrome.storage.local.set({
    profiles: [{ id: sessionId, name: 'P', hue: 0 }],
    [`cookies_${sessionId}`]: store,
  })
}

const lastAddRules = () => updateSessionRules().mock.calls.at(-1)[0].addRules
const cookieRules = (rules) => rules.filter((rule) => rule.action.requestHeaders?.[0]?.operation === 'set')
const ruleFor = (rules, value) => rules.find((rule) => rule.action.requestHeaders?.[0]?.value === value)

beforeEach(() => {
  updateSessionRules().mockReset()
  updateSessionRules().mockResolvedValue({})
})

describe('updateDNRRulesForTab — the site the tab is on or heading to comes first', () => {
  it('publishes the tab\'s own site when the profile holds more hosts than the tab has rules', async () => {
    await seedProfile('s_own', wellUsedStore())
    chrome.tabs.get.mockResolvedValue({ id: 101, url: `https://${SITE_HOST}/wp-login.php` })

    await updateDNRRulesForTab(101, 's_own')

    const rules = lastAddRules()
    expect(rules).toHaveLength(100)
    expect(ruleFor(rules, 'test_cookie=test_cookie')).toBeDefined()
    expect(ruleFor(rules, 'auth=auth; test_cookie=test_cookie')).toBeDefined()
  })

  it('a tab still on about:blank is built for the URL it was opened for, Secure cookies included', async () => {
    await seedProfile('s_opened', wellUsedStore())
    chrome.tabs.get.mockResolvedValue({ id: 102, url: 'about:blank' })

    await updateDNRRulesForTab(102, 's_opened', `https://${SITE_HOST}/wp-login.php`)

    const authRule = ruleFor(lastAddRules(), 'auth=auth; test_cookie=test_cookie')
    expect(authRule.condition.regexFilter).toBe('^https://blog\\.example\\.org(?::[0-9]+)?/wp-admin(?:[/?#]|$)')

    // A sibling tab's capture republishes this tab before it has navigated:
    // the URL it was opened for must not be forgotten.
    await updateDNRRulesForTab(102, 's_opened')
    expect(ruleFor(lastAddRules(), 'auth=auth; test_cookie=test_cookie')).toBeDefined()
  })

  it('once the tab has committed a page, its scheme is the page\'s, not the URL it was opened for', async () => {
    await seedProfile('s_scheme', wellUsedStore(0))
    chrome.tabs.get.mockResolvedValue({ id: 103, url: 'about:blank' })
    await updateDNRRulesForTab(103, 's_scheme', `https://${SITE_HOST}/`)

    chrome.tabs.get.mockResolvedValue({ id: 103, url: `http://${SITE_HOST}/` })
    await updateDNRRulesForTab(103, 's_scheme')
    // http: the Secure cookie is withheld.
    expect(cookieRules(lastAddRules()).map((r) => r.action.requestHeaders[0].value)).toEqual(['test_cookie=test_cookie'])

    chrome.tabs.get.mockResolvedValue({ id: 103, url: 'chrome://settings/' })
    await updateDNRRulesForTab(103, 's_scheme')
    expect(cookieRules(lastAddRules()).every((rule) => !rule.condition.regexFilter && !rule.condition.urlFilter)).toBe(true)
  })

  it('a pending navigation\'s site is placed first too', async () => {
    await seedProfile('s_pending', wellUsedStore())
    chrome.tabs.get.mockResolvedValue({
      id: 104, url: 'https://a000.example/', pendingUrl: `https://${SITE_HOST}/wp-admin/`,
    })

    await updateDNRRulesForTab(104, 's_pending')

    expect(ruleFor(lastAddRules(), 'auth=auth; test_cookie=test_cookie')).toBeDefined()
  })

  it('records what the published rules leave out', async () => {
    await seedProfile('s_cover', wellUsedStore())
    chrome.tabs.get.mockResolvedValue({ id: 105, url: 'https://a000.example/' })

    await updateDNRRulesForTab(105, 's_cover')

    const later = Date.now() + 1000
    expect(leftOutSite(105, `https://${SITE_HOST}/wp-login.php`, later)).toBe('example.org')
    expect(leftOutSite(105, 'https://a000.example/', later)).toBeNull()
  })

  it('spends at most 20 regex rules per tab', async () => {
    await seedProfile('s_regex', wellUsedStore())
    chrome.tabs.get.mockResolvedValue({ id: 106, url: `https://${SITE_HOST}/` })

    await updateDNRRulesForTab(106, 's_regex')

    const rules = lastAddRules()
    expect(rules.filter((rule) => rule.condition.regexFilter)).toHaveLength(20)
    // The tab's own host is among them: it may be served on a non-default port.
    expect(ruleFor(rules, 'test_cookie=test_cookie').condition.regexFilter).toBeDefined()
  })

  it('removes the rules and forgets the coverage when the tab goes back to the default session', async () => {
    await seedProfile('s_default', wellUsedStore())
    chrome.tabs.get.mockResolvedValue({ id: 107, url: 'https://a000.example/' })
    await updateDNRRulesForTab(107, 's_default')

    await updateDNRRulesForTab(107, 'default')

    expect(updateSessionRules().mock.calls.at(-1)[0].addRules).toEqual([])
    expect(hasPublishedRules(107)).toBe(false)
  })
})

describe('updateDNRRulesForTab — what a restarted worker assumes was live', () => {
  it('judges a request that started before its first publish by rules built for the page the tab is on', async () => {
    await seedProfile('s_restart', wellUsedStore())
    // The tab sits on another site and is heading to the blog: the rules live in
    // Chrome were built for the page it is on, and left the blog out.
    chrome.tabs.get.mockResolvedValue({ id: 108, url: 'https://a000.example/', pendingUrl: `https://${SITE_HOST}/` })
    const startedBefore = Date.now() - 50

    await updateDNRRulesForTab(108, 's_restart')

    expect(leftOutSite(108, `https://${SITE_HOST}/`, startedBefore)).toBe('example.org')
    expect(leftOutSite(108, `https://${SITE_HOST}/`, 0)).toBe('example.org')
    expect(leftOutSite(108, `https://${SITE_HOST}/`, Date.now() + 1000)).toBeNull()
  })

  it('publishes nothing for a tab that no longer exists', async () => {
    await seedProfile('s_gone', wellUsedStore())
    chrome.tabs.get.mockRejectedValueOnce(new Error('No tab with id: 109.'))

    await updateDNRRulesForTab(109, 's_gone')

    expect(updateSessionRules()).not.toHaveBeenCalled()
    expect(hasPublishedRules(109)).toBe(false)
  })
})

describe('updateDNRRulesForTab — Chrome refuses the rule set', () => {
  it('retries with the priority sites only and no regex rules, and says so', async () => {
    await seedProfile('s_refused', wellUsedStore())
    chrome.tabs.get.mockResolvedValue({ id: 201, url: `https://${SITE_HOST}/wp-login.php` })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    updateSessionRules().mockRejectedValueOnce(new Error('Session rule count for regex rules exceeded.'))

    await updateDNRRulesForTab(201, 's_refused')

    expect(updateSessionRules()).toHaveBeenCalledTimes(2)
    const rules = lastAddRules()
    expect(rules.some((rule) => rule.condition.regexFilter)).toBe(false)
    expect(cookieRules(rules).map((rule) => rule.condition.urlFilter).sort()).toEqual([
      `|https://${SITE_HOST}/`, `|https://${SITE_HOST}/wp-admin^`,
    ])
    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0][0]).toMatch(/Chrome refused 100 rule\(s\) for tab 201/)
    // The coverage reflects the rules that actually went live, not the refused ones.
    expect(leftOutSite(201, 'https://a000.example/', Date.now() + 1000)).toBe('a000.example')
    error.mockRestore()
  })

  it('rejects, loudly, when no rule set is accepted', async () => {
    await seedProfile('s_stuck', wellUsedStore())
    chrome.tabs.get.mockResolvedValue({ id: 202, url: `https://${SITE_HOST}/` })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    updateSessionRules().mockRejectedValue(new Error('Session rule count exceeded.'))

    await expect(updateDNRRulesForTab(202, 's_stuck')).rejects.toThrow('Session rule count exceeded.')

    expect(error.mock.calls.at(-1)[0]).toMatch(/tab 202 keeps its previous rules/)
    error.mockRestore()
  })
})

describe('updateDNRRulesForTab — overlapping publishes of one tab', () => {
  const versioned = (value) => ({ [cookieKey('v', SITE_HOST, '/')]: cookie('v', SITE_HOST, '/', { value }) })
  const publishedValues = () => updateSessionRules().mock.calls
    .map(([{ addRules }]) => cookieRules(addRules)[0]?.action.requestHeaders[0].value)

  it('an older publish that reaches Chrome last sends nothing: the newer store\'s rules stay live', async () => {
    await seedProfile('s_order', versioned('old'))
    chrome.tabs.get.mockResolvedValue({ id: 301, url: `https://${SITE_HOST}/` })
    // The first publish reads the store, then stalls before it gets to Chrome.
    let releaseOlderRead
    const realGet = chrome.storage.local.get.getMockImplementation()
    chrome.storage.local.get.mockImplementationOnce(async (keys) => {
      const snapshot = await realGet(keys)
      await new Promise((resolve) => { releaseOlderRead = resolve })
      return snapshot
    })
    const older = updateDNRRulesForTab(301, 's_order')
    await vi.waitFor(() => expect(releaseOlderRead).toBeDefined())

    await seedProfile('s_order', versioned('new'))
    await updateDNRRulesForTab(301, 's_order')
    expect(publishedValues()).toEqual(['v=new'])

    releaseOlderRead()
    await older

    expect(publishedValues()).toEqual(['v=new'])
  })

  it('does not make a publish wait for another one of the same tab', async () => {
    await seedProfile('s_parallel', versioned('a'))
    chrome.tabs.get.mockResolvedValue({ id: 302, url: `https://${SITE_HOST}/` })
    let releaseFirst
    updateSessionRules().mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve }))

    const first = updateDNRRulesForTab(302, 's_parallel')
    await vi.waitFor(() => expect(updateSessionRules()).toHaveBeenCalledTimes(1))
    // Chrome has not answered the first publish yet; the second goes out anyway.
    await updateDNRRulesForTab(302, 's_parallel')
    expect(updateSessionRules()).toHaveBeenCalledTimes(2)

    releaseFirst({})
    await first
  })

  it('a removal requested after a publish wins even when the publish gets to Chrome later', async () => {
    await seedProfile('s_removed', versioned('a'))
    let releaseTab
    chrome.tabs.get.mockImplementationOnce(() => new Promise((resolve) => { releaseTab = resolve }))
    const publish = updateDNRRulesForTab(303, 's_removed')
    await vi.waitFor(() => expect(releaseTab).toBeDefined())

    // The tab closes while its publish is still being prepared.
    await updateDNRRulesForTab(303, 'default')
    releaseTab({ id: 303, url: `https://${SITE_HOST}/` })
    await publish

    expect(updateSessionRules()).toHaveBeenCalledTimes(1)
    expect(updateSessionRules().mock.calls[0][0].addRules).toEqual([])
  })

  it('a failed publish does not block the next one', async () => {
    await seedProfile('s_recover', wellUsedStore(0))
    chrome.tabs.get.mockResolvedValue({ id: 304, url: `https://${SITE_HOST}/` })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    updateSessionRules().mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('boom'))

    await expect(updateDNRRulesForTab(304, 's_recover')).rejects.toThrow('boom')
    await updateDNRRulesForTab(304, 's_recover')

    expect(ruleFor(lastAddRules(), 'auth=auth; test_cookie=test_cookie')).toBeDefined()
    error.mockRestore()
  })

  it('a publish that defers to a newer one succeeds when that one succeeds on its retry', async () => {
    await seedProfile('s_defer', versioned('a'))
    chrome.tabs.get.mockResolvedValue({ id: 306, url: `https://${SITE_HOST}/` })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let releaseOlderRead
    const realGet = chrome.storage.local.get.getMockImplementation()
    chrome.storage.local.get.mockImplementationOnce(async (keys) => {
      const snapshot = await realGet(keys)
      await new Promise((resolve) => { releaseOlderRead = resolve })
      return snapshot
    })
    const older = updateDNRRulesForTab(306, 's_defer')
    await vi.waitFor(() => expect(releaseOlderRead).toBeDefined())

    // Chrome refuses the newer publish's full rule set; its fallback is accepted.
    let refuseNewer
    updateSessionRules().mockImplementationOnce(() => new Promise((_, reject) => { refuseNewer = reject }))
    const newer = updateDNRRulesForTab(306, 's_defer')
    await vi.waitFor(() => expect(refuseNewer).toBeDefined())
    releaseOlderRead()
    await new Promise((resolve) => setTimeout(resolve, 0))
    refuseNewer(new Error('refused'))

    await expect(Promise.all([older, newer])).resolves.toBeDefined()
    expect(updateSessionRules()).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })

  it('a removal is not undone by the coverage of a publish Chrome confirms afterwards', async () => {
    await seedProfile('s_late', versioned('a'))
    chrome.tabs.get.mockResolvedValue({ id: 307, url: `https://${SITE_HOST}/` })
    let confirmPublish
    updateSessionRules().mockImplementationOnce(() => new Promise((resolve) => { confirmPublish = resolve }))
    const publish = updateDNRRulesForTab(307, 's_late')
    await vi.waitFor(() => expect(confirmPublish).toBeDefined())

    await updateDNRRulesForTab(307, 'default')
    confirmPublish({})
    await publish

    expect(hasPublishedRules(307)).toBe(false)
  })

  it('a refused publish is not retried over a newer one that Chrome accepted', async () => {
    await seedProfile('s_retry', versioned('old'))
    chrome.tabs.get.mockResolvedValue({ id: 305, url: `https://${SITE_HOST}/` })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let refuseOlder
    updateSessionRules().mockImplementationOnce(() => new Promise((_, reject) => { refuseOlder = reject }))

    const older = updateDNRRulesForTab(305, 's_retry')
    await vi.waitFor(() => expect(refuseOlder).toBeDefined())
    await seedProfile('s_retry', versioned('new'))
    await updateDNRRulesForTab(305, 's_retry')

    refuseOlder(new Error('refused'))
    await older

    // Its fallback rule set, built from the older store, never goes out.
    expect(updateSessionRules()).toHaveBeenCalledTimes(2)
    expect(publishedValues().at(-1)).toBe('v=new')
    error.mockRestore()
  })
})
