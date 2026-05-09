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
 * Aggregate every session across every origin into a single flat array.
 * Origin is back-derived from the storage key (`list_${origin}`).
 * Result is stable-sorted by origin, then name, then id.
 * Duplicate session ids (rare) keep first occurrence and emit a console warning.
 *
 * @returns {Promise<Array<{id: string, name: string, hue: number|undefined, origin: string}>>}
 */
export async function getAllSessions() {
  const all = await chrome.storage.local.get(null);
  const seen = new Set();
  const out = [];

  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('list_') || !Array.isArray(value)) continue;
    const origin = key.slice('list_'.length);
    for (const s of value) {
      if (!s || typeof s.id !== 'string') continue;
      if (seen.has(s.id)) {
        console.warn('[session-store] duplicate session id across origins:', s.id);
        continue;
      }
      seen.add(s.id);
      out.push({ id: s.id, name: s.name || s.id, hue: s.hue, origin });
    }
  }

  out.sort((a, b) =>
    a.origin.localeCompare(b.origin) ||
    (a.name || '').localeCompare(b.name || '') ||
    a.id.localeCompare(b.id)
  );
  return out;
}

/**
 * Find cookie stores (`cookies_${id}`) with no corresponding entry in any
 * `list_${origin}`. Skips internal sessions (default, _snap_*).
 *
 * @returns {Promise<string[]>} Orphan session ids
 */
export async function findOrphanedCookieStores() {
  const all = await chrome.storage.local.get(null);
  const referenced = new Set();

  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('list_') || !Array.isArray(value)) continue;
    for (const s of value) if (s && typeof s.id === 'string') referenced.add(s.id);
  }

  const orphans = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith('cookies_')) continue;
    const id = key.slice('cookies_'.length);
    if (isInternalSession(id)) continue;
    if (!referenced.has(id)) orphans.push(id);
  }
  return orphans;
}

/**
 * Get all auto-assign rules
 * @returns {Promise<Array>} Array of rule objects
 */
export async function getAssignRules() {
  const result = await chrome.storage.local.get(['assign_rules'])
  return result['assign_rules'] || []
}

/**
 * Persist auto-assign rules
 * @param {Array} rules
 * @returns {Promise<void>}
 */
export async function setAssignRules(rules) {
  await chrome.storage.local.set({ assign_rules: rules })
}

/**
 * Duplicate a session — clones cookie store into new session with "(copy)" name suffix.
 * @param {string} sessionId - Source session id
 * @param {string} origin - Origin of the session
 * @returns {Promise<{id:string, name:string, hue:number}>} The new session object
 */
export async function duplicateSession(sessionId, origin) {
  const list = await getSessionList(origin);
  const source = list.find(s => s.id === sessionId);
  if (!source) throw new Error(`Session not found: ${sessionId}`);

  const newId = 'session_' + Math.random().toString(36).slice(2, 9);
  const store = await getCookieStore(sessionId);
  await setCookieStore(newId, { ...store });

  const newSession = { id: newId, name: source.name + ' (copy)', hue: source.hue };
  await setSessionList(origin, [...list, newSession]);
  return newSession;
}

/**
 * Export all sessions with their cookie stores as a serializable array.
 * @returns {Promise<Array<{name:string, hue:number, origin:string, cookies:Object}>>}
 */
export async function exportSessions() {
  const all = await getAllSessions();
  const result = [];
  for (const session of all) {
    const cookies = await getCookieStore(session.id);
    result.push({ name: session.name, hue: session.hue, origin: session.origin, cookies });
  }
  return result;
}

/**
 * Import sessions from an exported array. Never overwrites existing sessions;
 * always generates new IDs. Appends " (imported)" if name already exists for that origin.
 * @param {Array} exportedSessions
 * @returns {Promise<{imported: number}>}
 */
export async function importSessions(exportedSessions) {
  let imported = 0;
  for (const item of exportedSessions) {
    const { name, hue, origin, cookies } = item ?? {};
    if (!name || !origin || typeof cookies !== 'object') continue;
    // Validate origin is a well-formed URL origin to prevent storage key injection
    try { if (new URL(origin).origin !== origin) continue; } catch (_) { continue; }

    const list = await getSessionList(origin);
    const finalName = list.some(s => s.name === name) ? `${name} (imported)` : name;
    const newId = 'session_' + Math.random().toString(36).slice(2, 9);
    await setCookieStore(newId, cookies);
    await setSessionList(origin, [...list, { id: newId, name: finalName, hue: hue ?? 212 }]);
    imported++;
  }
  return { imported };
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
