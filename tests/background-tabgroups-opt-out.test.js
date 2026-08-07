import { describe, it, expect } from 'vitest'

// Phase 4 (tab-group sync)'s single most dangerous failure mode: a top-level
// `chrome.tabGroups.onUpdated.addListener(...)` in index.ts would throw a
// TypeError at service-worker evaluation for every user who never opted in,
// since `chrome.tabGroups` is `undefined` without the optional permission
// (tests/setup.js deliberately omits it from the default mock). Importing
// the background entry point here — with that permission absent, the way
// the vast majority of users will actually run this extension — is the
// regression guard: if a future edit reintroduces an unguarded reference,
// this import throws and the test file fails outright.
describe('background entry point with chrome.tabGroups unpermitted (default state)', () => {
  it('evaluates without throwing and makes zero grouping calls', async () => {
    await import('../background.js')
    expect(chrome.tabs.group).not.toHaveBeenCalled()
    expect(chrome.tabs.ungroup).not.toHaveBeenCalled()
    expect(chrome.permissions.request).not.toHaveBeenCalled()
  })
})
