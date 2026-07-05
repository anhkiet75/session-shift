// linked-tab-inheritance.ts — Opt-out: new tabs opened from a link inherit the opener's profile.
// Default on — `autoInheritProfileForLinkedTabs === false` is the only way to disable it;
// absent/undefined (e.g. pre-existing users, freshly-installed extension) means enabled.

import { tabSessions, persistTabSessions, updateBadge } from './session-manager.js'
import { updateDNRRulesForTab, stripCookiesOnNextNavigation } from './dnr-manager.js'
import { isInternalSession } from '../lib/session-store.js'
import { getExtSettings } from '../lib/settings-store.js'

// `tabs.onCreated` fires before the destination URL is known for target="_blank"
// / ctrl-click / middle-click tabs (tab.url is "" and tab.pendingUrl is
// undefined at that point) — too late to install a Cookie-strip DNR rule before
// the first request goes out. `webNavigation.onCreatedNavigationTarget` is
// purpose-built for exactly this tab-creation path and delivers `url`
// synchronously, closing that race.
export function registerLinkedTabInheritance(restored: Promise<void>): void {
  chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
    await restored
    const { sourceTabId, tabId, url } = details
    if (tabSessions[tabId] !== undefined) return // already assigned; don't clobber

    const settings = await getExtSettings()
    if (settings.autoInheritProfileForLinkedTabs === false) return

    const openerSessionId = tabSessions[sourceTabId]
    if (!openerSessionId || isInternalSession(openerSessionId)) return

    tabSessions[tabId] = openerSessionId
    await persistTabSessions()

    if (/^https?:/.test(url)) {
      stripCookiesOnNextNavigation(tabId, url)
    }
    await updateDNRRulesForTab(tabId, openerSessionId)
    updateBadge(tabId, openerSessionId)
  })
}
