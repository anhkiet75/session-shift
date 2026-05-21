import { describe, it, expect, vi } from 'vitest';
import { getAllSessions, findOrphanedCookieStores } from '../lib/session-store.js';

describe('getAllSessions', () => {
  it('returns empty array for empty storage', async () => {
    expect(await getAllSessions()).toEqual([]);
  });

  it('flattens sessions across origins, stable-sorted by origin then name', async () => {
    await chrome.storage.local.set({
      'list_https://b.com': [{ id: 's1', name: 'Beta', hue: 24 }],
      'list_https://a.com': [
        { id: 's3', name: 'Charlie', hue: 158 },
        { id: 's2', name: 'Alpha', hue: 212 },
      ],
    });
    const out = await getAllSessions();
    expect(out).toHaveLength(3);
    expect(out.map(s => s.origin)).toEqual([
      'https://a.com', 'https://a.com', 'https://b.com',
    ]);
    // within same origin, sorted by name
    expect(out[0].name).toBe('Alpha');
    expect(out[1].name).toBe('Charlie');
  });

  it('skips duplicate ids and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await chrome.storage.local.set({
      'list_https://a.com': [{ id: 'dup', name: 'A' }],
      'list_https://b.com': [{ id: 'dup', name: 'B' }],
    });
    const out = await getAllSessions();
    expect(out).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ignores non-list keys and malformed values', async () => {
    await chrome.storage.local.set({
      'cookies_session_x': { foo: 1 },
      'list_https://a.com': null,
      'list_https://b.com': 'not-an-array',
      'list_https://c.com': [{ id: 's1', name: 'Solo' }],
      'unrelated_key': { z: 9 },
    });
    const out = await getAllSessions();
    expect(out).toEqual([
      { id: 's1', name: 'Solo', hue: undefined, origin: 'https://c.com' },
    ]);
  });

  it('falls back to id when name is missing', async () => {
    await chrome.storage.local.set({
      'list_https://a.com': [{ id: 'session_xyz' }],
    });
    const [s] = await getAllSessions();
    expect(s.name).toBe('session_xyz');
  });
});

describe('findOrphanedCookieStores', () => {
  it('detects cookie stores with no list reference', async () => {
    await chrome.storage.local.set({
      'list_https://a.com': [{ id: 's1' }],
      'cookies_s1': {},
      'cookies_s2': {},
      'cookies_default': {},
      'cookies__snap_42_xyz': {},
    });
    expect(await findOrphanedCookieStores()).toEqual(['s2']);
  });

  it('returns empty when all cookie stores referenced', async () => {
    await chrome.storage.local.set({
      'list_https://a.com': [{ id: 's1' }, { id: 's2' }],
      'cookies_s1': {},
      'cookies_s2': {},
    });
    expect(await findOrphanedCookieStores()).toEqual([]);
  });

  it('returns empty for empty storage', async () => {
    expect(await findOrphanedCookieStores()).toEqual([]);
  });
});
