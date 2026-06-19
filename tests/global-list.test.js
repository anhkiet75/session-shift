import { describe, it, expect } from 'vitest';
import { getProfiles, findOrphanedCookieStores } from '../lib/session-store.js';

// Profile model: getProfiles returns the single global `profiles` list (no per-origin
// flattening). These cover robustness against a missing/malformed `profiles` key.

describe('getProfiles', () => {
  it('returns empty array for empty storage', async () => {
    expect(await getProfiles()).toEqual([]);
  });

  it('returns the stored profiles list as-is', async () => {
    await chrome.storage.local.set({
      profiles: [
        { id: 's1', name: 'Beta', hue: 24 },
        { id: 's2', name: 'Alpha', hue: 212 },
      ],
    });
    const out = await getProfiles();
    expect(out).toHaveLength(2);
    expect(out.map(s => s.id)).toEqual(['s1', 's2']);
  });

  it('treats a malformed (non-array) profiles value as empty', async () => {
    await chrome.storage.local.set({ profiles: 'not-an-array' });
    expect(await getProfiles()).toEqual([]);
  });
});

describe('findOrphanedCookieStores', () => {
  it('detects cookie stores with no profiles reference', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 's1' }],
      cookies_s1: {},
      cookies_s2: {},
      cookies_default: {},
    });
    expect(await findOrphanedCookieStores()).toEqual(['s2']);
  });

  it('returns empty when all cookie stores referenced', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 's1' }, { id: 's2' }],
      cookies_s1: {},
      cookies_s2: {},
    });
    expect(await findOrphanedCookieStores()).toEqual([]);
  });

  it('returns empty for empty storage', async () => {
    expect(await findOrphanedCookieStores()).toEqual([]);
  });
});
