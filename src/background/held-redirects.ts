// held-redirects.ts — Redirects in profile tabs that set cookies are followed by
// SessionShift, not by Chrome.
//
// A profile tab's cookies come only from DNR rules, which are republished
// asynchronously after each Set-Cookie capture. Chrome follows a redirect
// immediately — on a fast origin the next hop is sent ~1 ms later, before the
// capture finishes — so a login redirect would go out with the pre-login
// session and land on a logged-out page. Re-sending the hop afterwards is not
// safe: it already reached the server and consumed one-shot state such as
// flashed validation errors.
//
// So for navigation responses that set cookies, a DNR rule removes `Location`
// (`dnr-cookie-rule-builder.ts`). Chrome then commits the 3xx as an empty
// document instead of following it. The content script sees the 3xx status at
// document_start, stops the document, and asks for the target here; the answer
// comes only after the response's cookies are captured and published, and the
// content script finishes the hop with `location.replace` (same history as a
// native redirect). Every hop is therefore sent with the right cookies.

import { whenCapturesSettled } from './redirect-hop-stale-cookie-guard.js';

const RESOLVE_TIMEOUT_MS = 2000;

type HeldRedirect = { requestId: string; target: string };

const heldRedirects = new Map<string, HeldRedirect>();
const arrivalWaiters = new Map<string, Array<() => void>>();

const frameKey = (tabId: number, frameId: number) => `${tabId}:${frameId}`;

/** The target a 3xx navigation response would have followed, or null. */
export function heldRedirectTarget(details: chrome.webRequest.OnHeadersReceivedDetails): string | null {
  if (details.type !== 'main_frame' && details.type !== 'sub_frame') return null;
  if (details.statusCode < 300 || details.statusCode > 399) return null;
  const location = details.responseHeaders?.find((h) => h.name.toLowerCase() === 'location')?.value;
  if (!location) return null;
  try {
    return new URL(location, details.url).href;
  } catch {
    return null;
  }
}

/**
 * onHeadersReceived, synchronously: this frame's document will be the held 3xx.
 * Must run before the response's cookie capture starts awaiting.
 */
export function noteHeldRedirect(tabId: number, frameId: number, requestId: string, target: string): void {
  const key = frameKey(tabId, frameId);
  heldRedirects.set(key, { requestId, target });
  const waiters = arrivalWaiters.get(key) ?? [];
  arrivalWaiters.delete(key);
  for (const resolve of waiters) resolve();
}

function waitForArrival(key: string): Promise<boolean> {
  if (heldRedirects.has(key)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(heldRedirects.has(key)), RESOLVE_TIMEOUT_MS);
    arrivalWaiters.set(key, [...(arrivalWaiters.get(key) ?? []), () => {
      clearTimeout(timer);
      resolve(true);
    }]);
  });
}

/**
 * Called by the held document's content script. Resolves with the target URL
 * once the redirect response's cookies are live in DNR, or null when this frame
 * has no held redirect (a genuine 3xx document without Location).
 */
export async function resolveHeldRedirect(tabId: number, frameId: number): Promise<string | null> {
  const key = frameKey(tabId, frameId);
  // The content script can ask before onHeadersReceived has been processed.
  if (!(await waitForArrival(key))) return null;
  const held = heldRedirects.get(key);
  if (!held) return null;
  heldRedirects.delete(key);
  await whenCapturesSettled(held.requestId);
  return held.target;
}

/** tabs.onRemoved: a closed tab's id may be reused. */
export function forgetHeldRedirectsForTab(tabId: number): void {
  for (const key of heldRedirects.keys()) {
    if (key.startsWith(`${tabId}:`)) heldRedirects.delete(key);
  }
}
