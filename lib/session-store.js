/**
 * Session Store Helpers
 *
 * Centralized storage access patterns for session isolation.
 * All functions use chrome.storage.local with Promise-based API (MV3).
 */

/**
 * Get cookie store for a session
 * @param {string} sessionId - Session identifier
 * @returns {Promise<Object>} Cookie store object or empty object
 */
export async function getCookieStore(sessionId) {
  const result = await chrome.storage.local.get([`cookies_${sessionId}`]);
  return result[`cookies_${sessionId}`] || {};
}

/**
 * Set cookie store for a session
 * @param {string} sessionId - Session identifier
 * @param {Object} store - Cookie store object
 * @returns {Promise<void>}
 */
export async function setCookieStore(sessionId, store) {
  await chrome.storage.local.set({ [`cookies_${sessionId}`]: store });
}

/**
 * Get session list for an origin
 * @param {string} origin - URL origin
 * @returns {Promise<Array>} Array of session IDs or empty array
 */
export async function getSessionList(origin) {
  const result = await chrome.storage.local.get([`list_${origin}`]);
  return result[`list_${origin}`] || [];
}

/**
 * Set session list for an origin
 * @param {string} origin - URL origin
 * @param {Array} list - Array of session IDs
 * @returns {Promise<void>}
 */
export async function setSessionList(origin, list) {
  await chrome.storage.local.set({ [`list_${origin}`]: list });
}

/**
 * Returns true for sessions that should be treated as the default (global) session:
 * the literal 'default' value and internal snapshot sessions (_snap_*).
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isInternalSession(sessionId) {
  return !sessionId || sessionId === 'default' || sessionId.startsWith('_snap_');
}

/**
 * Delete all data for a session
 * Removes cookies_${sessionId} and all session_${sessionId}_* keys
 * @param {string} sessionId - Session identifier
 * @returns {Promise<void>}
 */
export async function deleteSessionData(sessionId) {
  const allKeys = await chrome.storage.local.get(null);
  const keysToRemove = [];

  for (const key of Object.keys(allKeys)) {
    if (
      key === `cookies_${sessionId}` ||
      key.startsWith(`session_${sessionId}_`)
    ) {
      keysToRemove.push(key);
    }
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}
