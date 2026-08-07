import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getIconSetForHue, resetIconCache } from '../background/profile-icon-renderer.js'
import { updateBadge } from '../background/session-manager.js'
import { profileColorCss } from '../lib/profile-color.js'

beforeEach(() => {
  resetIconCache()
})

describe('getIconSetForHue', () => {
  it('renders ImageData at both densities Chrome asks for', async () => {
    const set = await getIconSetForHue(212)
    expect(set[16]).toMatchObject({ width: 16, height: 16 })
    expect(set[32]).toMatchObject({ width: 32, height: 32 })
  })

  it('fills the tile with the same color the badge uses', async () => {
    const set = await getIconSetForHue(158)
    const fills = set[32].__calls.filter(([op]) => op === 'fill' || op === 'fillRect')
    expect(fills[0][1]).toBe(profileColorCss(158))
  })

  it('recolors the logo to a white silhouette so it survives any hue', async () => {
    const set = await getIconSetForHue(212)
    // The silhouette pass runs on its own canvas: draw logo, then source-in white.
    const silhouette = set[32].__calls.find(([op]) => op === 'drawImage')
    expect(silhouette).toBeDefined()
  })

  it('returns the cached set on a second call for the same hue', async () => {
    const first = await getIconSetForHue(212)
    const second = await getIconSetForHue(212)
    expect(second).toBe(first)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('renders a distinct set per hue but reuses the one logo fetch', async () => {
    const a = await getIconSetForHue(212)
    const b = await getIconSetForHue(24)
    expect(b).not.toBe(a)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects and stays retryable when OffscreenCanvas is unavailable', async () => {
    const saved = globalThis.OffscreenCanvas
    delete globalThis.OffscreenCanvas
    await expect(getIconSetForHue(212)).rejects.toThrow(/OffscreenCanvas/)
    globalThis.OffscreenCanvas = saved
    // A failed render must not be cached as a permanent rejection.
    await expect(getIconSetForHue(212)).resolves.toBeDefined()
  })

  it('rejects and stays retryable when the logo cannot be fetched', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline') })
    await expect(getIconSetForHue(212)).rejects.toThrow('offline')
    globalThis.fetch = vi.fn(async () => ({ ok: true, blob: async () => ({}) }))
    await expect(getIconSetForHue(212)).resolves.toBeDefined()
  })
})

describe('updateBadge icon wiring', () => {
  it('sets a rendered icon for a profiled tab', async () => {
    await chrome.storage.local.set({ profiles: [{ id: 'session_work', name: 'Work', hue: 158 }] })
    await updateBadge(7, 'session_work')
    const call = chrome.action.setIcon.mock.calls.at(-1)[0]
    expect(call.tabId).toBe(7)
    expect(call.imageData[16]).toMatchObject({ width: 16 })
    expect(call.imageData[32]).toMatchObject({ width: 32 })
  })

  it('restores the static path icons for internal sessions', async () => {
    await updateBadge(1, 'default')
    const call = chrome.action.setIcon.mock.calls.at(-1)[0]
    expect(call.path).toBeDefined()
    expect(call.imageData).toBeUndefined()
  })

  it('still updates the badge when rasterization fails', async () => {
    delete globalThis.OffscreenCanvas
    await chrome.storage.local.set({ profiles: [{ id: 'session_work', name: 'Work', hue: 158 }] })
    await expect(updateBadge(7, 'session_work')).resolves.toBeUndefined()
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'WOR', tabId: 7 })
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalled()
  })

  it('survives setIcon rejecting', async () => {
    chrome.action.setIcon = vi.fn().mockRejectedValue(new Error('nope'))
    await chrome.storage.local.set({ profiles: [{ id: 'session_work', name: 'Work', hue: 158 }] })
    await expect(updateBadge(7, 'session_work')).resolves.toBeUndefined()
  })
})
