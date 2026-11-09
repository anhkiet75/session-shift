import { handleMessage as dispatch } from '../../src/background/index.js';
import type { BackgroundMessage, Session } from '../../src/lib/types.js';
import { handleBeforeSendHeaders as before, handleHeadersReceived as headers, handleRequestCompleted as completed } from '../../src/background/dnr-manager.js';

// Supply browser metadata unrelated to the scenario being tested.
export function tab(id: number, url: string): chrome.tabs.Tab {
  return { id, url, index: 0, pinned: false, highlighted: false, windowId: 1, active: true, incognito: false, selected: true, discarded: false, autoDiscardable: true, groupId: -1, frozen: false };
}
const metadata = { requestId: 'test-request', url: 'https://example.com/', method: 'GET', frameId: 0, parentFrameId: -1, tabId: -1, timeStamp: 0, type: 'main_frame' as const, documentLifecycle: 'active' as const, frameType: 'outermost_frame' as const };
export const handleBeforeSendHeaders = (details: Partial<chrome.webRequest.OnBeforeSendHeadersDetails>) => before({ ...metadata, ...details });
export const handleHeadersReceived = (details: Partial<chrome.webRequest.OnHeadersReceivedDetails>) => headers({ ...metadata, statusCode: 200, statusLine: 'HTTP/1.1 200 OK', ...details });
export const handleRequestCompleted = (details: Partial<chrome.webRequest.OnCompletedDetails>) => completed({ ...metadata, statusCode: 200, statusLine: 'HTTP/1.1 200 OK', fromCache: false, ...details });
interface Response {
  success?: boolean;
  error?: string;
  sessionId?: string;
  cookieStr?: string;
  session?: Session;
  [key: string]: unknown;
}
export async function handleMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<Response> {
  // Allow malformed inputs to exercise the real runtime message boundary.
  const value: unknown = await dispatch(message as BackgroundMessage, sender);
  if (typeof value !== 'object' || value === null) throw new Error('Expected a message response object');
  return value as Response;
}
