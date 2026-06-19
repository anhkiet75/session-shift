import { describe, it, expect, vi } from 'vitest'
import { buildDnrRulesForCookieStore } from '../background/dnr-cookie-rule-builder.js'
import { cookieKey } from '../lib/cookie-parser.js'

function hostCookie(name, host, path) {
  return { name, value: name.toLowerCase(), domain: host, path, expires: null }
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
  })
}

describe('buildDnrRulesForCookieStore — rule budget', () => {
  it('drops deepest-path scopes first so root scopes survive the cap', () => {
    const host = 'shop.example.com'
    const store = {
      [cookieKey('A', host, '/')]: hostCookie('A', host, '/'),
      [cookieKey('B', host, '/deep/page')]: hostCookie('B', host, '/deep/page'),
      [cookieKey('C', host, '/mid')]: hostCookie('C', host, '/mid'),
    }

    // Budget: 2 base rules (request + response strip) + 2 cookie rules.
    // Three scopes compete for two slots.
    const rules = buildDnrRulesForCookieStore({
      tabId: 1,
      ruleIds: [1, 2, 3, 4],
      boundHost: host,
      scheme: 'https',
      store,
      serializeOpts: {},
      resourceTypes: ['main_frame'],
    })

    expect(rules.length).toBe(4)
    const filters = rules.map((rule) => rule.condition.regexFilter ?? '')
    expect(filters.some((f) => f === '^https://shop\\.example\\.com(?::[0-9]+)?/')).toBe(true)
    expect(filters.some((f) => f.includes('/mid'))).toBe(true)
    expect(filters.some((f) => f.includes('/deep/page'))).toBe(false)
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
  it('console.warn fires with dropped count when the rule budget is exceeded', () => {
    const host = 'shop.example.com'
    const store = {
      [cookieKey('A', host, '/')]: hostCookie('A', host, '/'),
      [cookieKey('B', host, '/deep/page')]: hostCookie('B', host, '/deep/page'),
      [cookieKey('C', host, '/mid')]: hostCookie('C', host, '/mid'),
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 2 base + 1 scope slot → 2 of 3 scopes dropped.
    buildDnrRulesForCookieStore({
      tabId: 7, ruleIds: [1, 2, 3], boundHost: host, scheme: 'https',
      store, serializeOpts: {}, resourceTypes: ['main_frame'],
    })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/budget.*exhausted.*tab 7/)
    warn.mockRestore()
  })
})
