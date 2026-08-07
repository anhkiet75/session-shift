import { describe, it, expect } from 'vitest'
import { updateBadge } from '../background/session-manager.js'

describe('updateBadge', () => {
  it('clears badge + restores default icon for internal sessions', async () => {
    await updateBadge(1, 'default')
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '', tabId: 1 })
    expect(chrome.action.setIcon).toHaveBeenCalled()
  })

  it('reads label + hue from the global profiles list (no origin lookup)', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_work', name: 'Work', hue: 158 }],
    })
    await updateBadge(7, 'session_work')
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'WOR', tabId: 7 })
    // Bold badge fill as the unambiguous [r,g,b,a] form; hue 158 at 85%/42%.
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: [16, 198, 131, 255],
      tabId: 7,
    })
    // Green that saturated is light enough that a black label wins on contrast.
    expect(chrome.action.setBadgeTextColor).toHaveBeenCalledWith({
      color: [0, 0, 0, 255],
      tabId: 7,
    })
  })

  it('skips setBadgeTextColor when Chrome is older than 110', async () => {
    delete chrome.action.setBadgeTextColor
    await chrome.storage.local.set({ profiles: [{ id: 'session_work', name: 'Work', hue: 158 }] })
    await expect(updateBadge(7, 'session_work')).resolves.toBeUndefined()
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'WOR', tabId: 7 })
  })

  it('falls back to id-derived label when the profile is not found', async () => {
    await chrome.storage.local.set({ profiles: [] })
    await updateBadge(9, 'session_abc123')
    // label = first 3 chars of id minus the `session_` prefix, upper-cased
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'ABC', tabId: 9 })
  })
})
