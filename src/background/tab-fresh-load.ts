// tab-fresh-load.ts — Force one tab's next navigation to complete, then hard
// reload it once, bypassing the disk cache.
//
// SessionShift profiles share Chrome's real HTTP disk cache — they're cookie
// jars within one browser profile, not separate contexts. A server that never
// sends `Vary: Cookie` can let a cache hit serve a response fetched under a
// DIFFERENT profile's cookies, silently: no request even goes out, so DNR's
// per-navigation Cookie strip never gets a chance to run.
// `chrome.tabs.reload({ bypassCache: true })` is the one API that actually
// skips that lookup, and it only works on an already-navigated tab — there is
// no bypass-cache option on `tabs.create`/`tabs.update`. So `createSessionTab`
// lets the first navigation start normally and this forces one hard reload
// once it completes, guaranteeing what the user ends up seeing was fetched
// under the new profile's cookies, not read back from a stale cache entry.
//
// The listener unregisters itself before issuing that reload — otherwise the
// reload's own completion would re-trigger it, looping forever.
//
// `beforeReload` exists because a reload IS a second navigation, and a caller
// that armed one-shot, per-navigation state for the first navigation (e.g.
// `createSessionTab`'s `stripCookiesOnNextNavigation`) needs the chance to
// re-arm it — that state is consumed and cleared once the first navigation
// completes, so without this hook the forced reload would go out as a bare,
// unprotected second navigation. It is awaited before the reload fires, so an
// async DNR rule publish inside it is guaranteed live before that request
// goes out.

export function forceFreshLoadOnce(tabId: number, beforeReload?: () => Promise<void> | void): void {
  const onUpdated = async (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo): Promise<void> => {
    if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
    stop();
    await beforeReload?.();
    chrome.tabs.reload(tabId, { bypassCache: true }).catch(() => {});
  };

  // Tab closed before its first navigation ever finished — nothing to reload,
  // and a closed tab's numeric id could otherwise be reused by an unrelated
  // later tab that this listener was never meant to react to.
  const onRemoved = (removedTabId: number): void => {
    if (removedTabId !== tabId) return;
    stop();
  };

  function stop(): void {
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
  }

  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);
}
