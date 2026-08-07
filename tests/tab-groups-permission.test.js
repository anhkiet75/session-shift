import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hasTabGroupsPermission, reconcileTabGroupsSetting } from '../lib/tab-groups-permission.js'
import { getExtSettings, setExtSettings } from '../lib/settings-store.js'

beforeEach(() => {
  chrome.permissions = {
    contains: vi.fn().mockResolvedValue(false),
    request: vi.fn(),
    remove: vi.fn(),
    onAdded: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  }
})

describe('hasTabGroupsPermission', () => {
  it('reflects chrome.permissions.contains', async () => {
    chrome.permissions.contains.mockResolvedValue(true)
    expect(await hasTabGroupsPermission()).toBe(true)
    expect(chrome.permissions.contains).toHaveBeenCalledWith({ permissions: ['tabGroups'] })
  })

  it('fails closed (false) if the permissions API throws', async () => {
    chrome.permissions.contains.mockRejectedValue(new Error('boom'))
    expect(await hasTabGroupsPermission()).toBe(false)
  })
})

describe('reconcileTabGroupsSetting', () => {
  it('does nothing when the setting is already off', async () => {
    await setExtSettings({ theme: 'system', groupTabsByProfile: false })
    expect(await reconcileTabGroupsSetting()).toBe(false)
    expect(chrome.permissions.contains).not.toHaveBeenCalled()
  })

  it('does nothing when the setting is on and the grant is still present', async () => {
    await setExtSettings({ theme: 'system', groupTabsByProfile: true })
    chrome.permissions.contains.mockResolvedValue(true)
    expect(await reconcileTabGroupsSetting()).toBe(false)
    expect((await getExtSettings()).groupTabsByProfile).toBe(true)
  })

  it('turns the setting off when it is on but the grant is gone', async () => {
    await setExtSettings({ theme: 'system', groupTabsByProfile: true })
    chrome.permissions.contains.mockResolvedValue(false)
    expect(await reconcileTabGroupsSetting()).toBe(true)
    expect((await getExtSettings()).groupTabsByProfile).toBe(false)
  })
})
