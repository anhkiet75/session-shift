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
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: 'hsl(158, 70%, 45%)',
      tabId: 7,
    })
  })

  it('falls back to id-derived label when the profile is not found', async () => {
    await chrome.storage.local.set({ profiles: [] })
    await updateBadge(9, 'session_abc123')
    // label = first 3 chars of id minus the `session_` prefix, upper-cased
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'ABC', tabId: 9 })
  })
})
