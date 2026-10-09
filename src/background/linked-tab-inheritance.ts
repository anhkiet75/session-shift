// linked-tab-inheritance.ts — Opt-out: new tabs opened from a link inherit the opener's profile.
// Default on — `autoInheritProfileForLinkedTabs === false` is the only way to disable it;
// absent/undefined (e.g. pre-existing users, freshly-installed extension) means enabled.

import { tabSessions, persistTabSessions, updateBadge } from './session-manager.js'
import { updateDNRRulesForTab } from './dnr-manager.js'
import { markTabJoinedProfile } from './pre-assignment-navigations.js'
import { isInternalSession } from '../lib/session-store.js'
import { getExtSettings } from '../lib/settings-store.js'

// `tabs.onCreated` fires before the destination URL is known for target="_blank"
// / ctrl-click / middle-click tabs (tab.url is "" and tab.pendingUrl is
// undefined at that point) — too late to install the profile's DNR rules before
// the first request goes out. `webNavigation.onCreatedNavigationTarget` is
// purpose-built for exactly this tab-creation path and delivers `url`
// synchronously, closing that race.
export function registerLinkedTabInheritance(restored: Promise<void>): void {
  chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
    await restored
    const { sourceTabId, tabId } = details
    if (tabSessions[tabId] !== undefined) return // already assigned; don't clobber

    const settings = await getExtSettings()
    if (settings.autoInheritProfileForLinkedTabs === false) return

    const openerSessionId = tabSessions[sourceTabId]
    if (!openerSessionId || isInternalSession(openerSessionId)) return

    // Rules first, assignment second: responses to requests sent before the
    // rules were live are never captured into the profile (the tab has no
    // profile yet), and those requests are re-issued below.
    await updateDNRRulesForTab(tabId, openerSessionId)
    tabSessions[tabId] = openerSessionId
    // The link's first request usually left before these rules existed, with
    // Chrome's own jar (the normal account): it is distrusted and the page is
    // re-requested under the profile (pre-assignment-navigations.ts).
    markTabJoinedProfile(tabId, Date.now())
    await persistTabSessions()
    updateBadge(tabId, openerSessionId)
  })
}
