// rule-matcher.js — Pure hostname pattern matching for auto-assign rules.
// No chrome APIs; safe to import in tests without mocks.

/**
 * Normalize a URL or raw hostname string to a bare lowercase hostname.
 * Strips scheme, path, query, hash, and port.
 * Examples:
 *   'https://github.com/foo' → 'github.com'
 *   'GITHUB.COM:443'         → 'github.com'
 *   '*.github.com'           → '*.github.com'
 * @param {string} input
 * @returns {string}
 */
export function normalizePattern(input) {
  let s = (input || '').trim().toLowerCase()
  s = s.replace(/^https?:\/\//, '')
  s = s.split('/')[0].split('?')[0].split('#')[0]
  s = s.replace(/:\d+$/, '')
  return s
}

/**
 * Test whether a bare hostname matches a stored pattern.
 * Supports:
 *   exact match  — 'github.com' matches 'github.com'
 *   wildcard     — '*.github.com' matches 'foo.github.com' but NOT 'github.com'
 * @param {string} hostname
 * @param {string} pattern - already-normalized pattern from storage
 * @returns {boolean}
 */
function patternMatches(hostname, pattern) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2)
    return hostname !== suffix && hostname.endsWith('.' + suffix)
  }
  return hostname === pattern
}

/**
 * Return the first enabled rule whose pattern matches the given hostname,
 * or null if none match. First-match-wins (array order).
 * @param {string} hostname - bare hostname (e.g. 'github.com')
 * @param {Array<{pattern: string, enabled: boolean}>} rules
 * @returns {object|null}
 */
export function findMatchingRule(hostname, rules) {
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (patternMatches(hostname, rule.pattern)) return rule
  }
  return null
}
