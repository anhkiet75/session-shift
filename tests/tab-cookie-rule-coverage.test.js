import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  beginRuleSet,
  confirmRuleSet,
  discardRuleSet,
  distrustChain,
  forgetRequest,
  forgetTabRuleCoverage,
  hasPublishedRules,
  isDistrustedChain,
  isHopJudged,
  isLatestTopNavigation,
  leftOutSite,
  markHopJudged,
  noteRequestStart,
  noteTopNavigation,
  prioritySitesForTab,
  promoteSite,
  recordAssumedRuleSet,
  requestStartedAt,
  restorePromotedSites,
  siteOfUrl,
} from '../background/tab-cookie-rule-coverage.js'

const TAB = 7

function coverage(overrides = {}) {
  return {
    scopedHosts: new Set(),
    droppedHostPaths: new Map(),
    droppedDomainPaths: new Map(),
    defaultPortOnlyHosts: new Set(),
    ...overrides,
  }
}

const everything = () => coverage({ scopedHosts: new Set(['bank.example']) })
const withoutBank = () => coverage({
  scopedHosts: new Set(['bank.example']),
  droppedHostPaths: new Map([['bank.example', ['/']]]),
})

/** Hands a rule set to Chrome at `sentAt`; Chrome confirms it at `liveAt` (never, when omitted). */
function publish(rules, sentAt, liveAt) {
  vi.setSystemTime(sentAt)
  const set = beginRuleSet(TAB, rules)
  if (liveAt !== undefined) {
    vi.setSystemTime(liveAt)
    confirmRuleSet(set)
  }
  return set
}

beforeEach(() => {
  vi.useFakeTimers()
  forgetTabRuleCoverage(TAB)
  chrome.storage.session.set.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('leftOutSite — requests the rules send without the profile\'s cookies', () => {
  it('reports the site of a request to a host whose scope got no rule', () => {
    publish(withoutBank(), 1000, 1010)
    expect(leftOutSite(TAB, 'https://bank.example/account', 2000)).toBe('bank.example')
  })

  it('reports nothing when the rules leave nothing out, or the store holds nothing for the site', () => {
    publish(everything(), 1000, 1010)
    expect(leftOutSite(TAB, 'https://bank.example/account', 2000)).toBeNull()

    publish(withoutBank(), 3000, 3010)
    expect(leftOutSite(TAB, 'https://new-site.example/', 4000)).toBeNull()
  })

  it('is undefined while this worker does not know the tab\'s rules', () => {
    expect(hasPublishedRules(TAB)).toBe(false)
    expect(leftOutSite(TAB, 'https://bank.example/', 2000)).toBeUndefined()
  })

  it('only a dropped path that applies to the request counts', () => {
    publish(coverage({
      scopedHosts: new Set(['blog.example']),
      droppedHostPaths: new Map([['blog.example', ['/wp-admin']]]),
    }), 1000, 1010)
    expect(leftOutSite(TAB, 'https://blog.example/wp-login.php', 2000)).toBeNull()
    expect(leftOutSite(TAB, 'https://blog.example/wp-admin/', 2000)).toBe('blog.example')
    expect(leftOutSite(TAB, 'https://blog.example/wp-administrator', 2000)).toBeNull()
  })

  it('a dropped Domain= scope covers hosts without rules of their own, not hosts that have them', () => {
    publish(coverage({
      scopedHosts: new Set(['www.shop.example']),
      droppedDomainPaths: new Map([['shop.example', ['/']]]),
    }), 1000, 1010)
    // api.shop.example has no host rules: it depended on the dropped domain rule.
    expect(leftOutSite(TAB, 'https://api.shop.example/v1', 2000)).toBe('shop.example')
    // www.shop.example has its own rules, each already carrying the domain cookies.
    expect(leftOutSite(TAB, 'https://www.shop.example/', 2000)).toBeNull()
    expect(leftOutSite(TAB, 'https://unrelated.example/', 2000)).toBeNull()
  })

  it('an explicit port is left out when the host\'s rules only match the default port', () => {
    publish(coverage({
      scopedHosts: new Set(['dev.example']),
      defaultPortOnlyHosts: new Set(['dev.example']),
    }), 1000, 1010)
    expect(leftOutSite(TAB, 'https://dev.example/', 2000)).toBeNull()
    expect(leftOutSite(TAB, 'https://dev.example:8443/', 2000)).toBe('dev.example')
  })

  it('ignores non-web URLs', () => {
    publish(withoutBank(), 1000, 1010)
    expect(leftOutSite(TAB, 'chrome-extension://abc/page.html', 2000)).toBeNull()
    expect(leftOutSite(TAB, 'not a url', 2000)).toBeNull()
  })
})

// Chrome matches a request against the rules when it starts, and an update
// takes time to reach Chrome: the worker only knows when it sent the update and
// when Chrome confirmed it.
describe('leftOutSite — judged against every rule set that may have been live', () => {
  it('a request started before the covering rules were sent is still left out', () => {
    publish(withoutBank(), 1000, 1010)
    publish(everything(), 3000, 3010)

    expect(leftOutSite(TAB, 'https://bank.example/', 2500)).toBe('bank.example')
    expect(leftOutSite(TAB, 'https://bank.example/', 3010)).toBeNull()
  })

  it('a request started while an update is in flight is left out if either side of it leaves the site out', () => {
    publish(withoutBank(), 1000, 1010)
    // Covering rules sent at 3000, confirmed at 3050: at 3020 either may be live.
    publish(everything(), 3000, 3050)
    expect(leftOutSite(TAB, 'https://bank.example/', 3020)).toBe('bank.example')

    // The other way round: rules that drop the site are in flight over ones that had it.
    forgetTabRuleCoverage(TAB)
    publish(everything(), 1000, 1010)
    publish(withoutBank(), 3000, 3050)
    expect(leftOutSite(TAB, 'https://bank.example/', 3020)).toBe('bank.example')
    expect(leftOutSite(TAB, 'https://bank.example/', 2999)).toBeNull()
  })

  it('an update Chrome has not confirmed yet counts from the moment it was sent', () => {
    publish(everything(), 1000, 1010)
    publish(withoutBank(), 3000)
    expect(leftOutSite(TAB, 'https://bank.example/', 3500)).toBe('bank.example')
  })

  it('picks the right rule set after several later publishes', () => {
    publish(withoutBank(), 1000, 1010)
    publish(everything(), 2000, 2010)
    publish(everything(), 3000, 3010)
    publish(everything(), 4000, 4010)
    // Judged late: the request started back when the first set was the live one.
    expect(leftOutSite(TAB, 'https://bank.example/', 1500)).toBe('bank.example')
    expect(leftOutSite(TAB, 'https://bank.example/', 2500)).toBeNull()
  })

  it('a rule set Chrome refused never counts', () => {
    publish(everything(), 1000, 1010)
    const refused = publish(withoutBank(), 3000)
    discardRuleSet(TAB, refused)
    expect(leftOutSite(TAB, 'https://bank.example/', 3500)).toBeNull()
  })

  it('a request older than every remembered rule set is judged by the oldest one', () => {
    publish(withoutBank(), 1000, 1010)
    expect(leftOutSite(TAB, 'https://bank.example/', 500)).toBe('bank.example')
  })

  it('an assumed rule set stands for everything before this worker\'s first publish', () => {
    recordAssumedRuleSet(TAB, withoutBank())
    publish(everything(), 5000, 5010)

    // Started before the worker did (start time unknown, 0) or before its publish.
    expect(leftOutSite(TAB, 'https://bank.example/', 0)).toBe('bank.example')
    expect(leftOutSite(TAB, 'https://bank.example/', 4999)).toBe('bank.example')
    expect(leftOutSite(TAB, 'https://bank.example/', 5010)).toBeNull()
    // Recording it again never replaces what the worker has learned since.
    recordAssumedRuleSet(TAB, everything())
    expect(leftOutSite(TAB, 'https://bank.example/', 0)).toBe('bank.example')
  })
})

describe('request chains', () => {
  it('remembers when each hop started, and forgets the hop before it', () => {
    noteRequestStart('chain', 'https://a.example/', 1000)
    expect(requestStartedAt('chain', 'https://a.example/')).toBe(1000)

    noteRequestStart('chain', 'https://b.example/', 1200)
    expect(requestStartedAt('chain', 'https://b.example/')).toBe(1200)
    // A hop this worker never saw start: it started before the worker did.
    expect(requestStartedAt('chain', 'https://a.example/')).toBe(0)
    expect(requestStartedAt('unknown', 'https://a.example/')).toBe(0)
  })

  it('tracks judged hops and distrusted chains until the chain is over', () => {
    markHopJudged('chain', 'https://a.example/')
    distrustChain('chain')
    expect(isHopJudged('chain', 'https://a.example/')).toBe(true)
    expect(isHopJudged('chain', 'https://b.example/')).toBe(false)
    expect(isDistrustedChain('chain')).toBe(true)

    forgetRequest('chain')
    expect(isHopJudged('chain', 'https://a.example/')).toBe(false)
    expect(isDistrustedChain('chain')).toBe(false)
    expect(requestStartedAt('chain', 'https://a.example/')).toBe(0)
  })

  it('knows the tab\'s latest top-level navigation', () => {
    noteTopNavigation(TAB, 'first')
    expect(isLatestTopNavigation(TAB, 'first')).toBe(true)
    noteTopNavigation(TAB, 'second')
    expect(isLatestTopNavigation(TAB, 'first')).toBe(false)
    expect(isLatestTopNavigation(TAB, 'second')).toBe(true)
  })
})

describe('priority sites', () => {
  it('lists where the tab is and is going first, then promoted sites, most recent first', () => {
    promoteSite(TAB, 'tracker.example')
    promoteSite(TAB, 'sso.example')

    expect(prioritySitesForTab(TAB, ['https://www.shop.example/cart', undefined, 'about:blank', 'http://localhost:3000/']))
      .toEqual(['shop.example', 'localhost', 'sso.example', 'tracker.example'])
  })

  it('promoting a site moves it to the front, and says whether that changed anything', () => {
    expect(promoteSite(TAB, 'a.example')).toBe(true)
    expect(promoteSite(TAB, 'b.example')).toBe(true)
    expect(promoteSite(TAB, 'a.example')).toBe(true)
    expect(prioritySitesForTab(TAB, [])).toEqual(['a.example', 'b.example'])

    // Already first: the rules cannot serve it any better, and nothing is written.
    chrome.storage.session.set.mockClear()
    expect(promoteSite(TAB, 'a.example')).toBe(false)
    expect(chrome.storage.session.set).not.toHaveBeenCalled()
  })

  it('keeps a bounded number of promoted sites, dropping the oldest', () => {
    for (let i = 0; i < 120; i++) promoteSite(TAB, `site${i}.example`)
    const sites = prioritySitesForTab(TAB, [])
    expect(sites).toHaveLength(100)
    expect(sites[0]).toBe('site119.example')
    expect(sites).not.toContain('site19.example')
  })

  it('persists promoted sites and restores them after a worker restart, keeping newer promotions', async () => {
    promoteSite(TAB, 'sso.example')
    expect(chrome.storage.session.set).toHaveBeenLastCalledWith({ tabPromotedSites: { [TAB]: ['sso.example'] } })

    chrome.storage.session.get.mockResolvedValueOnce({ tabPromotedSites: { [TAB]: ['stale.example'], 8: ['kept.example'] } })
    await restorePromotedSites()

    expect(prioritySitesForTab(TAB, [])).toEqual(['sso.example'])
    expect(prioritySitesForTab(8, [])).toEqual(['kept.example'])
    forgetTabRuleCoverage(8)
  })

  it('forgetting a tab drops its rules, promoted sites and latest navigation', () => {
    publish(withoutBank(), 1000, 1010)
    promoteSite(TAB, 'sso.example')
    noteTopNavigation(TAB, 'nav')

    forgetTabRuleCoverage(TAB)

    expect(hasPublishedRules(TAB)).toBe(false)
    expect(prioritySitesForTab(TAB, [])).toEqual([])
    expect(isLatestTopNavigation(TAB, 'nav')).toBe(false)
  })
})

describe('siteOfUrl', () => {
  it('returns the eTLD+1 of web URLs only', () => {
    expect(siteOfUrl('https://a.b.example.co.uk/x')).toBe('example.co.uk')
    expect(siteOfUrl('http://127.0.0.1:8080/')).toBe('127.0.0.1')
    expect(siteOfUrl('about:blank')).toBeNull()
    expect(siteOfUrl('')).toBeNull()
    expect(siteOfUrl(undefined)).toBeNull()
  })
})
