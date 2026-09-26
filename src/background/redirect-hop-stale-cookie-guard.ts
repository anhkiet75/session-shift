// redirect-hop-stale-cookie-guard.ts — Keeps a redirect hop that outran the
// previous hop's Set-Cookie capture from overwriting the fresh cookies.
//
// Set-Cookie is captured asynchronously (webRequest is non-blocking in MV3) and
// only then is the tab's DNR `Cookie: set` rule rebuilt. Chrome follows a
// redirect immediately, so the next hop of the same request chain can go out
// carrying the profile's previous cookies. When the redirecting response
// rotated the session (Laravel/Rails/Django login), the stale hop is answered
// as a guest; capturing that guest Set-Cookie would overwrite the login cookie,
// and every later hop stays one step behind — the tab loops /admin <-> /login.
// Fast origins such as localhost lose this race every time.
//
// The guard drops the Set-Cookie of such a stale hop instead. The hop itself is
// not re-sent: it has already reached the server, and a second copy would
// consume one-shot session state such as flashed validation errors. Session
// redirect chains converge on their own once the next hop carries the fresh
// cookie (auth middleware bounces a guest to /login, guest middleware bounces
// the logged-in session back).

// requestId -> number of Set-Cookie captures still in flight for that chain.
// Every hop of a redirect chain shares one requestId.
const pendingCaptures = new Map<string, number>();
// requestId -> URL of the latest hop sent while a capture was pending.
const staleHops = new Map<string, string>();
// requestId -> callers waiting for that chain's captures to be published.
const settleWaiters = new Map<string, Array<() => void>>();

/** Called synchronously when a response with Set-Cookie starts capture. */
export function beginCookieCapture(requestId: string): void {
  pendingCaptures.set(requestId, (pendingCaptures.get(requestId) ?? 0) + 1);
}

/** Called once the capture and DNR rebuild have finished. */
export function endCookieCapture(requestId: string): void {
  const remaining = (pendingCaptures.get(requestId) ?? 1) - 1;
  if (remaining > 0) {
    pendingCaptures.set(requestId, remaining);
    return;
  }
  pendingCaptures.delete(requestId);
  const waiters = settleWaiters.get(requestId) ?? [];
  settleWaiters.delete(requestId);
  for (const resolve of waiters) resolve();
}

/** Resolves once every Set-Cookie capture of this request chain has been published. */
export function whenCapturesSettled(requestId: string): Promise<void> {
  if (!pendingCaptures.has(requestId)) return Promise.resolve();
  return new Promise((resolve) => {
    settleWaiters.set(requestId, [...(settleWaiters.get(requestId) ?? []), resolve]);
  });
}

/** onBeforeSendHeaders: records whether this hop left before its predecessor's capture finished. */
export function noteRequestHop(requestId: string, url: string): void {
  if (pendingCaptures.has(requestId)) staleHops.set(requestId, url);
  else staleHops.delete(requestId);
}

/** True when this response belongs to a hop that was sent with stale cookies. */
export function isStaleHopResponse(requestId: string, url: string): boolean {
  return staleHops.get(requestId) === url;
}

/** onCompleted / onErrorOccurred: the chain is over, drop its state. */
export function forgetRequestChain(requestId: string): void {
  staleHops.delete(requestId);
}
