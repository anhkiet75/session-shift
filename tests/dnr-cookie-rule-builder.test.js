import { describe, it, expect } from 'vitest'
import { buildDnrRulesForCookieStore } from '../background/dnr-cookie-rule-builder.js'
import { cookieKey } from '../lib/cookie-parser.js'

function hostCookie(name, host, path) {
  return { name, value: name.toLowerCase(), domain: host, path, expires: null }
}

describe('buildDnrRulesForCookieStore — rule budget', () => {
  it('drops deepest-path scopes first so root scopes survive the cap', () => {
    const host = 'shop.example.com'
    const store = {
      [cookieKey('A', host, '/')]: hostCookie('A', host, '/'),
      [cookieKey('B', host, '/deep/page')]: hostCookie('B', host, '/deep/page'),
      [cookieKey('C', host, '/mid')]: hostCookie('C', host, '/mid'),
    }

    // Budget: 1 base rule + 2 cookie rules. Three scopes compete for two slots.
    const rules = buildDnrRulesForCookieStore({
      tabId: 1,
      ruleIds: [1, 2, 3],
      boundHost: host,
      scheme: 'https',
      store,
      serializeOpts: {},
      resourceTypes: ['main_frame'],
    })

    expect(rules.length).toBe(3)
    const filters = rules.map((rule) => rule.condition.regexFilter ?? '')
    expect(filters.some((f) => f === '^https://shop\\.example\\.com(?::[0-9]+)?/')).toBe(true)
    expect(filters.some((f) => f.includes('/mid'))).toBe(true)
    expect(filters.some((f) => f.includes('/deep/page'))).toBe(false)
  })
})
