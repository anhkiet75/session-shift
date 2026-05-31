import { describe, it, expect, vi } from 'vitest'
import { updateDNRRulesForTab } from '../background/dnr-manager.js'
import { cookieKey } from '../lib/cookie-parser.js'

async function setupBoundSession({ sessionId, tabId, origin, tabUrl, store = {} }) {
  await chrome.storage.local.set({
    [`list_${origin}`]: [{ id: sessionId, name: 'Test', hue: 212, origin }],
    [`cookies_${sessionId}`]: store,
  })
  chrome.tabs.get.mockResolvedValue({ id: tabId, url: tabUrl })
}

describe('updateDNRRulesForTab', () => {
  it('uses eTLD+1 requestDomains plus scheme anchor for https-bound sessions', async () => {
    await setupBoundSession({
      sessionId: 'session_google',
      tabId: 10,
      origin: 'https://www.google.com',
      tabUrl: 'https://www.google.com/',
    })

    await updateDNRRulesForTab(10, 'session_google')

    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalledTimes(1)
    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls[0]
    expect(addRules[0].condition.requestDomains).toEqual(['google.com'])
    expect(addRules[0].condition.urlFilter).toBe('|https://')
  })

  it('keeps scheme anchoring for http-bound sessions', async () => {
    await setupBoundSession({
      sessionId: 'session_http',
      tabId: 11,
      origin: 'http://www.google.com',
      tabUrl: 'http://www.google.com/',
    })

    await updateDNRRulesForTab(11, 'session_http')

    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls.at(-1)
    expect(addRules[0].condition.requestDomains).toEqual(['google.com'])
    expect(addRules[0].condition.urlFilter).toBe('|http://')
  })

  it('omits urlFilter when a snap session has no http(s) scheme but still scopes by registrable domain', async () => {
    chrome.tabs.get.mockResolvedValue({ id: 12, url: 'chrome://settings/' })

    await updateDNRRulesForTab(12, '_snap_12_www.google.com')

    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls.at(-1)
    expect(addRules[0].condition.requestDomains).toEqual(['google.com'])
    expect(addRules[0].condition.urlFilter).toBeUndefined()
  })

  it('creates host/path-specific cookie rules so sibling subdomains do not receive host-only cookies', async () => {
    await setupBoundSession({
      sessionId: 'session_scoped',
      tabId: 13,
      origin: 'https://www.google.com',
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
    await setupBoundSession({
      sessionId: 'session_localhost',
      tabId: 14,
      origin: 'http://localhost:3000',
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
