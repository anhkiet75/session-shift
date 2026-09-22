import { describe, it, expect } from 'vitest'
import { forceFreshLoadOnce } from '../background/tab-fresh-load.js'

// The listener is `async` (it may `await` an optional beforeReload hook), so
// even a synchronous dispatch resolves the reload on a later microtask.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('forceFreshLoadOnce', () => {
  it('reloads with bypassCache once the tab reaches complete', async () => {
    forceFreshLoadOnce(401)

    chrome.tabs.onUpdated.__dispatch(401, { status: 'complete' }, {})
    await flush()

    expect(chrome.tabs.reload).toHaveBeenCalledWith(401, { bypassCache: true })
  })

  it('ignores updates for a different tab', async () => {
    forceFreshLoadOnce(401)

    chrome.tabs.onUpdated.__dispatch(999, { status: 'complete' }, {})
    await flush()

    expect(chrome.tabs.reload).not.toHaveBeenCalled()
  })

  it('ignores status transitions other than complete', async () => {
    forceFreshLoadOnce(401)

    chrome.tabs.onUpdated.__dispatch(401, { status: 'loading' }, {})
    await flush()

    expect(chrome.tabs.reload).not.toHaveBeenCalled()
  })

  it('unregisters before reloading — does not loop on the reload\'s own completion', async () => {
    forceFreshLoadOnce(401)

    chrome.tabs.onUpdated.__dispatch(401, { status: 'complete' }, {})
    await flush()
    expect(chrome.tabs.reload).toHaveBeenCalledTimes(1)

    // The reload just triggered will itself eventually fire its own
    // 'complete' — dispatching again must be a no-op now that the listener
    // has actually unregistered, or every hard reload would loop forever.
    chrome.tabs.onUpdated.__dispatch(401, { status: 'complete' }, {})
    await flush()
    expect(chrome.tabs.reload).toHaveBeenCalledTimes(1)
  })

  it('cleans up without reloading if the tab is closed first', async () => {
    forceFreshLoadOnce(401)

    chrome.tabs.onRemoved.__dispatch(401)
    await flush()

    expect(chrome.tabs.reload).not.toHaveBeenCalled()
    // Cleaned up on both events, not just the one that fired.
    chrome.tabs.onUpdated.__dispatch(401, { status: 'complete' }, {})
    await flush()
    expect(chrome.tabs.reload).not.toHaveBeenCalled()
  })

  it('ignores removal of an unrelated tab', async () => {
    forceFreshLoadOnce(401)

    chrome.tabs.onRemoved.__dispatch(999)
    chrome.tabs.onUpdated.__dispatch(401, { status: 'complete' }, {})
    await flush()

    expect(chrome.tabs.reload).toHaveBeenCalledWith(401, { bypassCache: true })
  })

  it('does not cross-trigger between two tabs in flight at once', async () => {
    forceFreshLoadOnce(401)
    forceFreshLoadOnce(402)

    chrome.tabs.onUpdated.__dispatch(402, { status: 'complete' }, {})
    await flush()

    expect(chrome.tabs.reload).toHaveBeenCalledTimes(1)
    expect(chrome.tabs.reload).toHaveBeenCalledWith(402, { bypassCache: true })
  })
})

describe('forceFreshLoadOnce — beforeReload hook', () => {
  it('awaits beforeReload before reloading', async () => {
    const order = []
    let resolveHook
    const hook = () => new Promise((resolve) => { resolveHook = () => { order.push('hook'); resolve() } })
    chrome.tabs.reload.mockImplementation(async () => { order.push('reload'); return {} })

    forceFreshLoadOnce(401, hook)
    chrome.tabs.onUpdated.__dispatch(401, { status: 'complete' }, {})

    // Still waiting on the hook — the reload must not have fired yet.
    await Promise.resolve()
    await Promise.resolve()
    expect(chrome.tabs.reload).not.toHaveBeenCalled()

    resolveHook()
    await flush()

    expect(order).toEqual(['hook', 'reload'])
  })

  it('still reloads exactly once when beforeReload is omitted', async () => {
    forceFreshLoadOnce(401)
    chrome.tabs.onUpdated.__dispatch(401, { status: 'complete' }, {})
    await flush()
    expect(chrome.tabs.reload).toHaveBeenCalledTimes(1)
  })
})
