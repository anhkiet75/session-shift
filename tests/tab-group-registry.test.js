import { describe, it, expect, beforeEach } from 'vitest'
import {
  restoreGroupRegistry, getGroupId, setGroupId, dropGroupId, dropWindow,
  dropGroupById, isManagedGroup, allEntries, clearRegistry,
} from '../background/tab-group-registry.js'

beforeEach(async () => {
  await clearRegistry()
})

describe('tab-group-registry', () => {
  it('returns undefined for an unregistered window/profile pair', () => {
    expect(getGroupId(1, 'session_work')).toBeUndefined()
  })

  it('round-trips a group id and persists it to chrome.storage.session', async () => {
    await setGroupId(1, 'session_work', 42)
    expect(getGroupId(1, 'session_work')).toBe(42)
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({ tabGroupRegistry: { 1: { session_work: 42 } } })
    )
  })

  it('restoreGroupRegistry reloads from chrome.storage.session', async () => {
    chrome.storage.session.get.mockResolvedValueOnce({ tabGroupRegistry: { 2: { session_home: 7 } } })
    await restoreGroupRegistry()
    expect(getGroupId(2, 'session_home')).toBe(7)
  })

  it('dropGroupId removes only the targeted entry and cleans up an empty window map', async () => {
    await setGroupId(1, 'session_work', 42)
    await setGroupId(1, 'session_home', 43)
    await dropGroupId(1, 'session_work')
    expect(getGroupId(1, 'session_work')).toBeUndefined()
    expect(getGroupId(1, 'session_home')).toBe(43)

    await dropGroupId(1, 'session_home')
    expect(allEntries()).toEqual([])
  })

  it('dropWindow removes the whole window sub-map', async () => {
    await setGroupId(1, 'session_work', 42)
    await setGroupId(2, 'session_work', 43)
    await dropWindow(1)
    expect(getGroupId(1, 'session_work')).toBeUndefined()
    expect(getGroupId(2, 'session_work')).toBe(43)
  })

  it('dropGroupById finds and removes an entry by group id regardless of window/profile', async () => {
    await setGroupId(1, 'session_work', 42)
    await dropGroupById(42)
    expect(getGroupId(1, 'session_work')).toBeUndefined()
  })

  it('isManagedGroup is true only for ids present in the registry', async () => {
    await setGroupId(1, 'session_work', 42)
    expect(isManagedGroup(42)).toBe(true)
    expect(isManagedGroup(99)).toBe(false)
  })

  it('allEntries flattens the registry into a single array', async () => {
    await setGroupId(1, 'session_work', 42)
    await setGroupId(2, 'session_home', 7)
    expect(allEntries()).toEqual(
      expect.arrayContaining([
        { windowId: 1, profileId: 'session_work', groupId: 42 },
        { windowId: 2, profileId: 'session_home', groupId: 7 },
      ])
    )
  })

  it('clearRegistry empties the in-memory map and persists the empty state', async () => {
    await setGroupId(1, 'session_work', 42)
    await clearRegistry()
    expect(allEntries()).toEqual([])
  })
})
