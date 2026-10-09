// pre-assignment-navigations.ts — Top-level requests a linked tab sent before
// its profile rules were live.
//
// A linked tab (target=_blank, ctrl/middle-click) starts navigating before
// `webNavigation.onCreatedNavigationTarget` can give it its opener's profile.
// That first request goes out with no profile rules, so it carries Chrome's
// own jar — the normal account's cookies — and the server answers that
// account. Capturing the response would copy the normal account into the
// profile, and the page itself belongs to the wrong account.
//
// Event order cannot be trusted to spot it: the request's webRequest events may
// reach the service worker after the tab has already been assigned. Requests
// are therefore judged by when they were sent (`details.timeStamp`) against
// when the tab's rules went live. An early request is never captured, and the
// tab re-requests the page once under the profile. A POST (form
// target=_blank) is not replayed.

const JOIN_WINDOW_MS = 10_000;

type Navigation = { requestId: string; method: string; sentAt: number };

// Tabs that joined a profile after they may have started navigating.
const joinedAt = new Map<number, number>();
// Main-frame requests seen from tabs with no profile yet.
const unassignedNavigations = new Map<number, Navigation[]>();
const untrustedResponses = new Set<string>();
const reloadedTabs = new Set<number>();

function reloadOnce(tabId: number): void {
  if (reloadedTabs.has(tabId)) return;
  reloadedTabs.add(tabId);
  chrome.tabs.reload(tabId, { bypassCache: true }).catch(() => {});
}

function distrust(tabId: number, navigation: Navigation): void {
  untrustedResponses.add(navigation.requestId);
  if (navigation.method === 'GET') reloadOnce(tabId);
}

/**
 * onBeforeSendHeaders for every main_frame request. `assigned` says whether
 * the tab currently has a profile.
 */
export function noteNavigationRequest(
  tabId: number, requestId: string, method: string, sentAt: number, assigned: boolean,
): void {
  const navigation = { requestId, method, sentAt };
  if (!assigned) {
    unassignedNavigations.set(tabId, [...(unassignedNavigations.get(tabId) ?? []), navigation]);
    return;
  }
  const liveAt = joinedAt.get(tabId);
  if (liveAt === undefined) return;
  if (sentAt < liveAt) distrust(tabId, navigation);
  else if (sentAt - liveAt > JOIN_WINDOW_MS) joinedAt.delete(tabId);
}

/**
 * The linked tab's profile rules are live as of `liveAt` and the tab is now
 * assigned. Requests it already sent before that are distrusted.
 */
export function markTabJoinedProfile(tabId: number, liveAt: number): void {
  joinedAt.set(tabId, liveAt);
  reloadedTabs.delete(tabId);
  for (const navigation of unassignedNavigations.get(tabId) ?? []) {
    if (navigation.sentAt < liveAt) distrust(tabId, navigation);
  }
  unassignedNavigations.delete(tabId);
}

/** True when this response answers a request sent before the tab had profile rules. */
export function isPreAssignmentResponse(requestId: string): boolean {
  return untrustedResponses.has(requestId);
}

/** onCompleted / onErrorOccurred. */
export function forgetPreAssignmentRequest(requestId: string): void {
  untrustedResponses.delete(requestId);
}

/** tabs.onRemoved: a closed tab's id may be reused. */
export function forgetPreAssignmentTab(tabId: number): void {
  joinedAt.delete(tabId);
  unassignedNavigations.delete(tabId);
  reloadedTabs.delete(tabId);
}
