import { describe, it, expect } from 'vitest'
import { updateDNRRulesForTab } from '../background/dnr-manager.js'
import { cookieKey } from '../lib/cookie-parser.js'

async function setupProfile({ sessionId, tabId, tabUrl, store = {} }) {
  await chrome.storage.local.set({
    profiles: [{ id: sessionId, name: 'Test', hue: 212 }],
    [`cookies_${sessionId}`]: store,
  })
  chrome.tabs.get.mockResolvedValue({ id: tabId, url: tabUrl })
}

describe('updateDNRRulesForTab', () => {
  it('base-strips Cookie and Set-Cookie for non-navigation resources', async () => {
    await setupProfile({
      sessionId: 'session_google',
      tabId: 10,
      tabUrl: 'https://www.google.com/',
    })

    await updateDNRRulesForTab(10, 'session_google')

    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalledTimes(1)
    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls[0]
    // addRules[0] = request-side Cookie strip, tab-scoped for subresources.
    expect(addRules[0].action.requestHeaders[0]).toEqual({ header: 'Cookie', operation: 'remove' })
    expect(addRules[0].condition.requestDomains).toBeUndefined()
    expect(addRules[0].condition.urlFilter).toBeUndefined()
    expect(addRules[0].condition.excludedRequestDomains).toBeUndefined()
    expect(addRules[0].condition.resourceTypes).not.toContain('main_frame')
    expect(addRules[0].condition.resourceTypes).not.toContain('sub_frame')
    const responseRules = addRules.filter((rule) => rule.action.responseHeaders?.[0]?.header === 'set-cookie')
    expect(responseRules.length).toBe(1)
    const [strictResponseRule] = responseRules
    expect(strictResponseRule.condition.excludedRequestDomains).toBeUndefined()
    expect(strictResponseRule.condition.requestDomains).toBeUndefined()
    expect(strictResponseRule.condition.urlFilter).toBeUndefined()
    expect(strictResponseRule.condition.resourceTypes).not.toContain('main_frame')
    expect(strictResponseRule.condition.resourceTypes).not.toContain('sub_frame')
  })

  it('keeps base stripping subresource-only for an http profile too', async () => {
    await setupProfile({
      sessionId: 'session_http',
      tabId: 11,
      tabUrl: 'http://www.google.com/',
    })

    await updateDNRRulesForTab(11, 'session_http')

    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls.at(-1)
    // The http scheme is still derived from the tab URL for cookie SET rules
    // (Secure exclusion), but base strips stay navigation-safe.
    const responseRules = addRules.filter((rule) => rule.action.responseHeaders?.[0]?.header === 'set-cookie')
    expect(addRules[0].condition.requestDomains).toBeUndefined()
    expect(addRules[0].condition.excludedRequestDomains).toBeUndefined()
    expect(responseRules.every((rule) => !rule.condition.excludedRequestDomains)).toBe(true)
    expect(addRules[0].condition.resourceTypes).not.toContain('main_frame')
    expect(responseRules.every((rule) => !rule.condition.resourceTypes.includes('main_frame'))).toBe(true)
  })

  it('strips same-site subresource cookies too while response-side stripping stays strict', async () => {
    await setupProfile({
      sessionId: 'session_github',
      tabId: 12,
      tabUrl: 'https://github.com/login',
    })

    await updateDNRRulesForTab(12, 'session_github')

    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls.at(-1)
    expect(addRules[0].condition.excludedRequestDomains).toBeUndefined()
    const responseRules = addRules.filter((rule) => rule.action.responseHeaders?.[0]?.header === 'set-cookie')
    expect(responseRules).toHaveLength(1)
    expect(responseRules[0].condition.excludedRequestDomains).toBeUndefined()
  })

  it('creates host/path-specific cookie rules so sibling subdomains do not receive host-only cookies', async () => {
    await setupProfile({
      sessionId: 'session_scoped',
      tabId: 13,
      tabUrl: 'https://www.google.com/',
      store: {
        [cookieKey('ROOT', '.google.com', '/')]: {
          name: 'ROOT',
          value: 'root',
          domain: '.google.com',
          path: '/',
          expires: null,
        },
        [cookieKey('ACCT', 'accounts.google.com', '/')]: {
          name: 'ACCT',
          value: 'acct',
          domain: 'accounts.google.com',
          path: '/',
          expires: null,
        },
        [cookieKey('ADMIN', '.google.com', '/admin')]: {
          name: 'ADMIN',
          value: 'admin',
          domain: '.google.com',
          path: '/admin',
          expires: null,
        },
      },
    })

    await updateDNRRulesForTab(13, 'session_scoped')

    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls.at(-1)
    const accountRule = addRules.find((rule) => rule.condition.regexFilter === '^https://accounts\\.google\\.com(?::[0-9]+)?/')
    const accountAdminRule = addRules.find((rule) =>
      rule.condition.regexFilter === '^https://accounts\\.google\\.com(?::[0-9]+)?/admin(?:[/?#]|$)'
    )
    const domainRootRule = addRules.find((rule) =>
      rule.condition.urlFilter === '|https://' &&
      rule.condition.requestDomains?.includes('google.com') &&
      rule.action.requestHeaders?.[0]?.value === 'ROOT=root'
    )

    expect(accountRule.action.requestHeaders[0].value).toBe('ROOT=root; ACCT=acct')
    expect(accountAdminRule.action.requestHeaders[0].value).toBe('ADMIN=admin; ROOT=root; ACCT=acct')
    expect(domainRootRule.action.requestHeaders[0].value).not.toContain('ACCT=acct')
  })

  it('allows ports on exact-host rules for localhost development origins', async () => {
    await setupProfile({
      sessionId: 'session_localhost',
      tabId: 14,
      tabUrl: 'http://localhost:3000/',
      store: {
        [cookieKey('user', 'localhost', '/')]: {
          name: 'user',
          value: 'alice',
          domain: 'localhost',
          path: '/',
          expires: null,
        },
      },
    })

    await updateDNRRulesForTab(14, 'session_localhost')

    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls.at(-1)
    const cookieRule = addRules.find((rule) => rule.action.requestHeaders?.[0]?.value === 'user=alice')
    expect(cookieRule.condition.regexFilter).toBe('^http://localhost(?::[0-9]+)?/')
  })
})
