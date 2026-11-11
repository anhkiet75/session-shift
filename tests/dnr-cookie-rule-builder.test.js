import { describe, it, expect, vi } from 'vitest'
import { buildDnrRulesForCookieStore } from '../background/dnr-cookie-rule-builder.js'
import { cookieKey } from '../lib/cookie-parser.js'

function hostCookie(name, host, path) {
  return { name, value: name.toLowerCase(), domain: host, path, expires: null }
}

function buildRuleSet(overrides = {}) {
  return buildDnrRulesForCookieStore({
    tabId: 1,
    ruleIds: Array.from({ length: 100 }, (_, i) => i + 1),
    boundHost: null,
    scheme: 'https',
    store: {},
    serializeOpts: {},
    resourceTypes: ['main_frame'],
    ...overrides,
  })
}

function build(overrides = {}) {
  return buildDnrRulesForCookieStore({
    tabId: 1,
    ruleIds: Array.from({ length: 100 }, (_, i) => i + 1),
    boundHost: 'shop.example.com',
    scheme: 'https',
    store: {},
    serializeOpts: {},
    resourceTypes: ['main_frame', 'image', 'websocket'],
    ...overrides,
  }).rules
}

describe('buildDnrRulesForCookieStore — rule budget', () => {
  it('drops deepest-path scopes first so root scopes survive the cap', () => {
    const host = 'shop.example.com'
    const store = {
      [cookieKey('A', host, '/')]: hostCookie('A', host, '/'),
      [cookieKey('B', host, '/deep/page')]: hostCookie('B', host, '/deep/page'),
      [cookieKey('C', host, '/mid')]: hostCookie('C', host, '/mid'),
    }

    // Budget: 3 base rules (request strip, response strip, held-redirect
    // Location removal) + 2 cookie rules. Three scopes compete for two slots.
    const { rules } = buildDnrRulesForCookieStore({
      tabId: 1,
      ruleIds: [1, 2, 3, 4, 5],
      boundHost: host,
      scheme: 'https',
      store,
      serializeOpts: {},
      resourceTypes: ['main_frame'],
    })

    expect(rules.length).toBe(5)
    const filters = rules.map((rule) => rule.condition.regexFilter ?? '')
    expect(filters.some((f) => f === '^https://shop\\.example\\.com(?::[0-9]+)?/')).toBe(true)
    expect(filters.some((f) => f.includes('/mid'))).toBe(true)
    expect(filters.some((f) => f.includes('/deep/page'))).toBe(false)
  })
})

describe('buildDnrRulesForCookieStore — held redirects', () => {
  it('removes Location only from cookie-setting navigation responses of the tab', () => {
    const held = build({}).find((rule) => rule.action.responseHeaders?.[0]?.header === 'location')
    expect(held.action.responseHeaders).toEqual([
      { header: 'location', operation: 'remove' },
      { header: 'server-timing', operation: 'append', value: 'sessionshift-held' },
    ])
    expect(held.condition.tabIds).toEqual([1])
    expect(held.condition.resourceTypes).toEqual(['main_frame', 'sub_frame'])
    expect(held.condition.responseHeaders).toEqual([{ header: 'set-cookie' }])
  })
})

describe('buildDnrRulesForCookieStore — third-party Cookie strip', () => {
  it('request-side Cookie strip is widened: tab-scoped, all schemes, no requestDomains', () => {
    const [requestRule] = build({ boundHost: null })
    expect(requestRule.action.requestHeaders[0]).toEqual({ header: 'Cookie', operation: 'remove' })
    expect(requestRule.condition.requestDomains).toBeUndefined()
    expect(requestRule.condition.urlFilter).toBeUndefined() // no scheme anchor → http/ws also stripped
    expect(requestRule.condition.tabIds).toEqual([1])
  })

  it('response-side Set-Cookie strip stays bound-host scoped when a bound host exists', () => {
    const responseRule = build()[1]
    expect(responseRule.action.responseHeaders[0]).toEqual({ header: 'set-cookie', operation: 'remove' })
    expect(responseRule.condition.requestDomains).toEqual(['example.com'])
    expect(responseRule.condition.urlFilter).toBe('|https://')
  })

  it('response-side Set-Cookie strip can exclude navigation resource types', () => {
    const responseRule = build({ responseStripResourceTypes: ['image', 'xmlhttprequest'] })[1]
    expect(responseRule.condition.resourceTypes).toEqual(['image', 'xmlhttprequest'])
  })

  it('request-side Cookie strip can exclude navigation resource types', () => {
    const requestRule = build({ requestStripResourceTypes: ['image', 'xmlhttprequest'] })[0]
    expect(requestRule.condition.resourceTypes).toEqual(['image', 'xmlhttprequest'])
  })

  it('request strip stays tab-scoped even when a first-party domain is present', () => {
    const rules = build({ boundHost: null, firstPartyDomain: 'github.com' })
    expect(rules[0].condition.excludedRequestDomains).toBeUndefined()
    expect(rules[1].condition.excludedRequestDomains).toBeUndefined()
  })

  it('null boundHost yields tab-scoped strip on both sides', () => {
    const rules = build({ boundHost: null, scheme: null })
    expect(rules[0].condition.requestDomains).toBeUndefined()
    expect(rules[1].condition.requestDomains).toBeUndefined()
  })

  it('a stored .eTLD+1 cookie still emits a domain set-rule matching all subdomains', () => {
    const store = {
      [cookieKey('ROOT', '.example.com', '/')]: {
        name: 'ROOT', value: 'r', domain: '.example.com', path: '/', expires: null,
      },
    }
    const rules = build({ store })
    const domainRule = rules.find((r) =>
      r.condition.requestDomains?.includes('example.com') &&
      r.action.requestHeaders?.[0]?.value === 'ROOT=r'
    )
    expect(domainRule).toBeDefined()
  })
})

describe('buildDnrRulesForCookieStore — budget-exhaustion warning', () => {
  const host = 'shop.example.com'
  const store = {
    [cookieKey('A', host, '/')]: hostCookie('A', host, '/'),
    [cookieKey('B', host, '/deep/page')]: hostCookie('B', host, '/deep/page'),
    [cookieKey('C', host, '/mid')]: hostCookie('C', host, '/mid'),
  }
  // 3 base rules + 1 scope slot → 2 of 3 scopes dropped.
  const buildOverBudget = (prioritySites) => buildDnrRulesForCookieStore({
    tabId: 7, ruleIds: [1, 2, 3, 4], boundHost: null, scheme: 'https',
    store, serializeOpts: {}, resourceTypes: ['main_frame'], prioritySites,
  })

  it('console.warn fires with the dropped count when a scope of the tab\'s own site is dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    buildOverBudget(['example.com'])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/budget.*exhausted.*tab 7; 2 cookie scope/)
    warn.mockRestore()
  })

  it('stays quiet when only other sites\' scopes are left out: that is recovered on demand', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    buildOverBudget(['other.example'])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

// A profile is a global jar: its store holds every site it ever visited. The
// tab's own sites must keep their rules however the other hosts sort.
describe('buildDnrRulesForCookieStore — the tab\'s own sites come first', () => {
  const wp = 'blog.example.org'
  function wellUsedStore(fillerPrefix) {
    const store = {
      [cookieKey('wordpress_test_cookie', wp, '/')]: hostCookie('wordpress_test_cookie', wp, '/'),
      [cookieKey('wordpress_sec', wp, '/wp-admin')]: hostCookie('wordpress_sec', wp, '/wp-admin'),
    }
    for (let i = 0; i < 110; i++) {
      const filler = `${fillerPrefix}${String(i).padStart(3, '0')}.example`
      store[cookieKey('sid', filler, '/')] = hostCookie('sid', filler, '/')
    }
    return store
  }
  const cookieValues = (rules) => rules.map((rule) => rule.action.requestHeaders?.[0]?.value).filter(Boolean)

  for (const fillerPrefix of ['a', 'z']) {
    it(`keeps every scope of the priority site when 110 other hosts sort ${fillerPrefix === 'a' ? 'before' : 'after'} it`, () => {
      const { rules, coverage } = buildRuleSet({ store: wellUsedStore(fillerPrefix), prioritySites: ['example.org'] })

      expect(rules).toHaveLength(100)
      expect(cookieValues(rules)).toContain('wordpress_test_cookie=wordpress_test_cookie')
      expect(cookieValues(rules)).toContain('wordpress_sec=wordpress_sec; wordpress_test_cookie=wordpress_test_cookie')
      expect(coverage.droppedHostPaths.has(wp)).toBe(false)
      // 97 scope slots, 2 for the site: 15 of the 110 other hosts are left out.
      expect(coverage.droppedHostPaths.size).toBe(15)
    })
  }

  it('without a priority site the same store leaves the site out (the reported bug)', () => {
    // Hosts sorting before it push out even its root scope: the login POST goes
    // out with no cookies ("Cookies are blocked").
    const before = buildRuleSet({ store: wellUsedStore('a'), prioritySites: [] }).coverage
    expect(before.droppedHostPaths.get(wp)).toEqual(['/', '/wp-admin'])
    // Hosts sorting after it still push out its deeper path: /wp-admin/ never
    // sees the auth cookie and bounces back to the login page.
    const after = buildRuleSet({ store: wellUsedStore('z'), prioritySites: [] }).coverage
    expect(after.droppedHostPaths.get(wp)).toEqual(['/wp-admin'])
  })

  it('orders priority sites among themselves: the first one listed is the last to lose a rule', () => {
    const { coverage } = buildRuleSet({
      store: wellUsedStore('a'),
      prioritySites: ['a109.example', 'example.org'],
      ruleIds: [1, 2, 3, 4, 5],
    })
    expect(coverage.droppedHostPaths.has('a109.example')).toBe(false)
    expect(coverage.droppedHostPaths.get(wp)).toEqual(['/wp-admin'])
  })

  it('prioritySitesOnly publishes nothing but the priority sites\' scopes', () => {
    const { rules, coverage } = buildRuleSet({
      store: wellUsedStore('a'), prioritySites: ['example.org'], prioritySitesOnly: true,
    })
    expect(rules).toHaveLength(3 + 2)
    expect(coverage.droppedHostPaths.size).toBe(110)
  })

  it('an expired or Secure-on-http cookie creates no scope, so it is never reported as left out', () => {
    const store = {
      [cookieKey('old', 'gone.example', '/')]: { ...hostCookie('old', 'gone.example', '/'), expires: 1 },
      [cookieKey('sec', 'tls.example', '/')]: { ...hostCookie('sec', 'tls.example', '/'), secure: true },
    }
    const { rules, coverage } = buildRuleSet({
      store, scheme: 'http', serializeOpts: { excludeSecure: true }, prioritySitesOnly: true,
    })
    expect(rules).toHaveLength(3)
    expect(coverage.scopedHosts.size).toBe(0)
    expect(coverage.droppedHostPaths.size).toBe(0)
  })
})

// A Domain= rule matches every host under its domain. When a host's own rule
// does not apply (it only matches the default port), the Domain= rule is what
// the request gets, so it must never carry another host's host-only cookies.
describe('buildDnrRulesForCookieStore — Domain= rules carry Domain= cookies only', () => {
  const store = {
    [cookieKey('shared', '.example.com', '/')]: { name: 'shared', value: 's', domain: '.example.com', path: '/', expires: null },
    [cookieKey('apexonly', 'example.com', '/')]: hostCookie('apexonly', 'example.com', '/'),
    [cookieKey('apponly', 'app.example.com', '/')]: hostCookie('apponly', 'app.example.com', '/'),
  }

  it('keeps the apex host\'s host-only cookie out of the rule that matches its subdomains', () => {
    const { rules } = buildRuleSet({ store, regexRuleBudget: 0 })
    const domainRule = rules.find((rule) => rule.condition.requestDomains?.includes('example.com'))

    expect(domainRule.action.requestHeaders[0].value).toBe('shared=s')
    // Each host's own rule still carries its host-only cookie plus the shared one.
    const valueFor = (filter) => rules.find((rule) => rule.condition.urlFilter === filter).action.requestHeaders[0].value
    expect(valueFor('|https://example.com/').split('; ').sort()).toEqual(['apexonly=apexonly', 'shared=s'])
    expect(valueFor('|https://app.example.com/').split('; ').sort()).toEqual(['apponly=apponly', 'shared=s'])
  })
})

// Chrome allows an extension 1000 regex session rules across all tabs; one per
// host scope per tab ran out at about ten tabs of a well-used profile.
describe('buildDnrRulesForCookieStore — regex rule budget', () => {
  const store = {
    [cookieKey('A', 'app.example.com', '/')]: hostCookie('A', 'app.example.com', '/'),
    [cookieKey('B', 'app.example.com', '/admin')]: hostCookie('B', 'app.example.com', '/admin'),
    [cookieKey('C', 'cdn.other.net', '/')]: hostCookie('C', 'cdn.other.net', '/'),
    [cookieKey('D', 'cdn.other.net', '/assets/')]: hostCookie('D', 'cdn.other.net', '/assets/'),
  }
  const conditionFor = (rules, value) =>
    rules.find((rule) => rule.action.requestHeaders?.[0]?.value === value).condition

  it('spends the regex rules on the priority site and matches the rest by exact URL prefix', () => {
    const { rules, coverage } = buildRuleSet({ store, prioritySites: ['example.com'], regexRuleBudget: 2 })

    expect(conditionFor(rules, 'A=a').regexFilter).toBe('^https://app\\.example\\.com(?::[0-9]+)?/')
    expect(conditionFor(rules, 'B=b; A=a').regexFilter).toBe('^https://app\\.example\\.com(?::[0-9]+)?/admin(?:[/?#]|$)')
    // No regex left: exact host on the default port, no subdomain, no other port.
    expect(conditionFor(rules, 'C=c')).toMatchObject({ urlFilter: '|https://cdn.other.net/' })
    expect(conditionFor(rules, 'D=d; C=c')).toMatchObject({ urlFilter: '|https://cdn.other.net/assets/' })
    expect(conditionFor(rules, 'C=c').regexFilter).toBeUndefined()
    expect(conditionFor(rules, 'C=c').requestDomains).toBeUndefined()
    expect([...coverage.defaultPortOnlyHosts]).toEqual(['cdn.other.net'])
  })

  it('a path without a trailing slash ends at a separator, so /admin does not match /administrator', () => {
    const { rules } = buildRuleSet({ store, regexRuleBudget: 0 })
    expect(conditionFor(rules, 'B=b; A=a').urlFilter).toBe('|https://app.example.com/admin^')
  })

  it('uses no regex at all with a zero budget', () => {
    const { rules, coverage } = buildRuleSet({ store, regexRuleBudget: 0 })
    expect(rules.some((rule) => rule.condition.regexFilter)).toBe(false)
    expect(coverage.defaultPortOnlyHosts).toEqual(new Set(['app.example.com', 'cdn.other.net']))
  })
})
