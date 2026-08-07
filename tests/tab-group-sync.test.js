import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  syncTabToGroup, syncProfileGroupAppearance, handleTabAttached, handleWindowRemoved,
  registerGuardedListeners, ungroupAllManaged,
} from '../background/tab-group-sync.js'
import {
  registerPermissionRemovedListener, registerSettingsListener, startupReconcile,
} from '../background/tab-group-lifecycle.js'
import { allEntries, getGroupId, setGroupId, clearRegistry } from '../background/tab-group-registry.js'
import { setExtSettings } from '../lib/settings-store.js'
import { handleMessage } from '../background.js'
import { tabSessions } from '../background/session-manager.js'

const SENDER = { id: chrome.runtime.id }

async function enableSetting() {
  await setExtSettings({ theme: 'system', groupTabsByProfile: true })
}

function mockGrantedTabGroups() {
  chrome.tabGroups = {
    // Defaults to windowId 1 (what most tests use) so the create/reuse tests
    // don't also have to stub windowId matching; a test needing a different
    // window overrides with .mockResolvedValueOnce/.mockRejectedValueOnce.
    get: vi.fn().mockImplementation(async (id) => ({ id, windowId: 1 })),
    update: vi.fn().mockResolvedValue({}),
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  }
  chrome.permissions.contains.mockResolvedValue(true)
}

beforeEach(async () => {
  await clearRegistry()
  await chrome.storage.local.set({ profiles: [{ id: 'session_work', name: 'Work', hue: 0 }] })
})

describe('opted-out path (chrome.tabGroups absent — the default mock state)', () => {
  it('syncTabToGroup, syncProfileGroupAppearance, ungroupAllManaged are all no-ops', async () => {
    await enableSetting()
    await expect(syncTabToGroup(1, 1, 'session_work')).resolves.toBeUndefined()
    await expect(syncProfileGroupAppearance('session_work')).resolves.toBeUndefined()
    await expect(ungroupAllManaged()).resolves.toBe(false)
    expect(chrome.tabs.group).not.toHaveBeenCalled()
    expect(chrome.tabs.ungroup).not.toHaveBeenCalled()
  })

  it('registerGuardedListeners does not throw and registers nothing', () => {
    expect(() => registerGuardedListeners()).not.toThrow()
  })

  it('setting off: syncTabToGroup makes zero calls even with chrome.tabGroups present', async () => {
    mockGrantedTabGroups()
    await syncTabToGroup(1, 1, 'session_work')
    expect(chrome.tabs.group).not.toHaveBeenCalled()
  })
})

describe('syncTabToGroup (permission granted)', () => {
  beforeEach(async () => {
    mockGrantedTabGroups()
    await enableSetting()
  })

  it('creates a new group on first sync and registers it', async () => {
    chrome.tabs.group.mockResolvedValue(101)
    await syncTabToGroup(5, 1, 'session_work')
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [5], createProperties: { windowId: 1 } })
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(101, { title: 'Work', color: 'red' })
    expect(getGroupId(1, 'session_work')).toBe(101)
  })

  it('reuses the existing group for a second tab in the same window/profile', async () => {
    await setGroupId(1, 'session_work', 55)
    await syncTabToGroup(6, 1, 'session_work')
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [6], groupId: 55 })
    expect(chrome.tabGroups.update).not.toHaveBeenCalled()
  })

  it('recreates the group when the registered id is stale (group no longer exists)', async () => {
    await setGroupId(1, 'session_work', 55)
    chrome.tabGroups.get.mockRejectedValueOnce(new Error('no such group'))
    chrome.tabs.group.mockResolvedValue(202)
    await syncTabToGroup(7, 1, 'session_work')
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [7], createProperties: { windowId: 1 } })
    expect(getGroupId(1, 'session_work')).toBe(202)
  })

  it('ignores internal sessions', async () => {
    await syncTabToGroup(1, 1, 'default')
    expect(chrome.tabs.group).not.toHaveBeenCalled()
  })
})

describe('syncProfileGroupAppearance (color + rename)', () => {
  beforeEach(async () => {
    mockGrantedTabGroups()
    await enableSetting()
  })

  it('recolors every registered group for the profile', async () => {
    await setGroupId(1, 'session_work', 10)
    await setGroupId(2, 'session_work', 11)
    await syncProfileGroupAppearance('session_work')
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(10, { title: 'Work', color: 'red' })
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(11, { title: 'Work', color: 'red' })
  })

  it('retitles every registered group after the profile is renamed', async () => {
    await setGroupId(1, 'session_work', 10)
    await chrome.storage.local.set({ profiles: [{ id: 'session_work', name: 'Renamed', hue: 0 }] })
    await syncProfileGroupAppearance('session_work')
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(10, { title: 'Renamed', color: 'red' })
  })

  it('drops the registry entry for a group that no longer exists', async () => {
    await setGroupId(1, 'session_work', 10)
    chrome.tabGroups.update.mockRejectedValueOnce(new Error('gone'))
    await syncProfileGroupAppearance('session_work')
    expect(getGroupId(1, 'session_work')).toBeUndefined()
  })
})

describe('handleTabAttached / handleWindowRemoved', () => {
  it('handleTabAttached is a no-op without a session id', async () => {
    mockGrantedTabGroups()
    await enableSetting()
    await handleTabAttached(1, 2, undefined)
    expect(chrome.tabs.group).not.toHaveBeenCalled()
  })

  it('handleTabAttached regroups the tab in the destination window', async () => {
    mockGrantedTabGroups()
    await enableSetting()
    chrome.tabs.group.mockResolvedValue(303)
    await handleTabAttached(1, 2, 'session_work')
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1], createProperties: { windowId: 2 } })
  })

  it('handleWindowRemoved drops the window sub-map', async () => {
    await setGroupId(9, 'session_work', 1)
    await handleWindowRemoved(9)
    expect(getGroupId(9, 'session_work')).toBeUndefined()
  })
})

describe('ungroupAllManaged', () => {
  it('ungroups every tab in every registered group, then clears the registry', async () => {
    mockGrantedTabGroups()
    await setGroupId(1, 'session_work', 10)
    chrome.tabs.query.mockResolvedValue([{ id: 1 }, { id: 2 }])
    await ungroupAllManaged()
    expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 1, groupId: 10 })
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([1, 2])
    expect(allEntries()).toEqual([])
  })

  it('returns false and leaves the registry alone when chrome.tabGroups is absent (nothing was actually ungrouped)', async () => {
    await setGroupId(1, 'session_work', 10)
    await expect(ungroupAllManaged()).resolves.toBe(false)
    expect(allEntries()).toEqual([{ windowId: 1, profileId: 'session_work', groupId: 10 }])
  })
})

describe('registerPermissionRemovedListener', () => {
  it('reconciles the setting off when tabGroups is revoked', async () => {
    let handler
    chrome.permissions.onRemoved.addListener.mockImplementation((fn) => { handler = fn })
    registerPermissionRemovedListener()
    await enableSetting()
    chrome.permissions.contains.mockResolvedValue(false)
    await handler({ permissions: ['tabGroups'] })
    const settings = await chrome.storage.local.get(['ext_settings'])
    expect(settings.ext_settings.groupTabsByProfile).toBe(false)
  })

  it('ignores removal of an unrelated permission', async () => {
    let handler
    chrome.permissions.onRemoved.addListener.mockImplementation((fn) => { handler = fn })
    registerPermissionRemovedListener()
    await enableSetting()
    await handler({ permissions: ['bookmarks'] })
    const settings = await chrome.storage.local.get(['ext_settings'])
    expect(settings.ext_settings.groupTabsByProfile).toBe(true)
  })
})

describe('registerSettingsListener', () => {
  it('ungroups and releases the grant when groupTabsByProfile transitions from true to false', async () => {
    let handler
    chrome.storage.onChanged.addListener.mockImplementation((fn) => { handler = fn })
    registerSettingsListener()
    await setGroupId(1, 'session_work', 10)
    mockGrantedTabGroups()
    chrome.tabs.query.mockResolvedValue([])
    handler(
      { ext_settings: { oldValue: { groupTabsByProfile: true }, newValue: { groupTabsByProfile: false } } },
      'local'
    )
    await vi.waitFor(() => expect(allEntries()).toEqual([]))
    await vi.waitFor(() => expect(chrome.permissions.remove).toHaveBeenCalledWith({ permissions: ['tabGroups'] }))
  })

  it('ignores changes outside the local area and unrelated keys', () => {
    let handler
    chrome.storage.onChanged.addListener.mockImplementation((fn) => { handler = fn })
    registerSettingsListener()
    expect(() => handler({ ext_settings: { oldValue: {}, newValue: {} } }, 'sync')).not.toThrow()
    expect(() => handler({ profiles: {} }, 'local')).not.toThrow()
  })
})

describe('startupReconcile', () => {
  it('does nothing when the setting is off', async () => {
    await startupReconcile()
    expect(chrome.permissions.contains).not.toHaveBeenCalled()
  })

  it('reconciles the setting to false and clears the registry when the grant is gone', async () => {
    await enableSetting()
    await setGroupId(1, 'session_work', 10)
    chrome.permissions.contains.mockResolvedValue(false)
    await startupReconcile()
    const settings = await chrome.storage.local.get(['ext_settings'])
    expect(settings.ext_settings.groupTabsByProfile).toBe(false)
    expect(allEntries()).toEqual([])
  })

  it('leaves the setting on when the grant still holds', async () => {
    await enableSetting()
    chrome.permissions.contains.mockResolvedValue(true)
    await startupReconcile()
    const settings = await chrome.storage.local.get(['ext_settings'])
    expect(settings.ext_settings.groupTabsByProfile).toBe(true)
  })
})

describe('on-transition full sync (registerSettingsListener, groupTabsByProfile false -> true)', () => {
  it('groups every currently-open profiled tab', async () => {
    mockGrantedTabGroups()
    chrome.tabs.group.mockResolvedValue(77)
    chrome.tabs.query.mockResolvedValue([
      { id: 1, windowId: 1 },
      { id: 2, windowId: 1 },
      { id: 3, windowId: 1 }, // no session assigned — must be skipped
    ])
    let handler
    chrome.storage.onChanged.addListener.mockImplementation((fn) => { handler = fn })
    registerSettingsListener()
    await enableSetting() // syncTabToGroup checks the real stored setting, not the event payload

    tabSessions[1] = 'session_work'
    tabSessions[2] = 'session_work'

    handler(
      { ext_settings: { oldValue: { groupTabsByProfile: false }, newValue: { groupTabsByProfile: true } } },
      'local'
    )
    await vi.waitFor(() => expect(getGroupId(1, 'session_work')).toBe(77))
    // Both tabs land in the same group — second call reuses it, doesn't recreate.
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1], createProperties: { windowId: 1 } })
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [2], groupId: 77 })

    delete tabSessions[1]
    delete tabSessions[2]
  })
})

describe('handleGroupUpdated (self-write and collapse-only changes must not drop ownership)', () => {
  it('does not release ownership when the event echoes our own applyGroupAppearance write', async () => {
    mockGrantedTabGroups()
    chrome.tabs.group.mockResolvedValue(88)
    await enableSetting()
    await syncTabToGroup(1, 1, 'session_work')
    expect(getGroupId(1, 'session_work')).toBe(88)

    registerGuardedListeners()
    const onUpdatedHandler = chrome.tabGroups.onUpdated.addListener.mock.calls[0][0]
    await onUpdatedHandler({ id: 88, title: 'Work', color: 'red' }) // exactly what applyGroupAppearance just wrote
    expect(getGroupId(1, 'session_work')).toBe(88) // still ours
  })

  it('does not release ownership on a collapse-only change (title/color unchanged)', async () => {
    mockGrantedTabGroups()
    chrome.tabs.group.mockResolvedValue(89)
    await enableSetting()
    await syncTabToGroup(1, 1, 'session_work')

    registerGuardedListeners()
    const onUpdatedHandler = chrome.tabGroups.onUpdated.addListener.mock.calls[0][0]
    await onUpdatedHandler({ id: 89, title: 'Work', color: 'red', collapsed: true })
    expect(getGroupId(1, 'session_work')).toBe(89)
  })

  it('releases ownership when the user actually renames/recolors a managed group', async () => {
    mockGrantedTabGroups()
    chrome.tabs.group.mockResolvedValue(90)
    await enableSetting()
    await syncTabToGroup(1, 1, 'session_work')

    registerGuardedListeners()
    const onUpdatedHandler = chrome.tabGroups.onUpdated.addListener.mock.calls[0][0]
    await onUpdatedHandler({ id: 90, title: 'My Own Name', color: 'blue' }) // user edit
    expect(getGroupId(1, 'session_work')).toBeUndefined()
  })
})

describe('setSession -> syncTabToGroup wiring (handleMessage integration)', () => {
  it('groups the tab when handleMessage receives setSession', async () => {
    mockGrantedTabGroups()
    await enableSetting()
    chrome.tabs.get.mockResolvedValue({ id: 42, windowId: 1 })
    chrome.tabs.group.mockResolvedValue(55)

    await handleMessage({ action: 'setSession', payload: { tabId: 42, sessionId: 'session_work' } }, SENDER)
    await vi.waitFor(() => expect(getGroupId(1, 'session_work')).toBe(55))
  })

  it('does not throw when chrome.tabs.get fails to resolve the tab (matches the pre-existing catch path)', async () => {
    mockGrantedTabGroups()
    await enableSetting()
    chrome.tabs.get.mockRejectedValue(new Error('no such tab'))

    const result = await handleMessage({ action: 'setSession', payload: { tabId: 999, sessionId: 'session_work' } }, SENDER)
    expect(result.success).toBe(true)
    expect(chrome.tabs.group).not.toHaveBeenCalled()
  })
})

describe('renameProfileGroups -> syncProfileGroupAppearance wiring (handleMessage integration)', () => {
  it('retitles an already-open group to the popup-renamed profile name', async () => {
    mockGrantedTabGroups()
    await enableSetting()
    await setGroupId(1, 'session_work', 10)
    await chrome.storage.local.set({ profiles: [{ id: 'session_work', name: 'Renamed', hue: 0 }] })

    const result = await handleMessage({ action: 'renameProfileGroups', payload: { sessionId: 'session_work' } }, SENDER)
    expect(result.success).toBe(true)
    await vi.waitFor(() => expect(chrome.tabGroups.update).toHaveBeenCalledWith(10, { title: 'Renamed', color: 'red' }))
  })

  it('rejects a non-string sessionId', async () => {
    const result = await handleMessage({ action: 'renameProfileGroups', payload: { sessionId: 42 } }, SENDER)
    expect(result.error).toBe('invalid payload')
  })
})
