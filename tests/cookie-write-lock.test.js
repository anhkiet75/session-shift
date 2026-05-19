import { describe, it, expect } from 'vitest'
import { withCookieLock } from '../lib/cookie-write-lock.js'

describe('withCookieLock (M1)', () => {
  it('serializes concurrent writes on the same sessionId', async () => {
    const order = []
    const p1 = withCookieLock('sid1', async () => {
      order.push('start1')
      await Promise.resolve() // yield to allow p2 to start waiting
      order.push('end1')
    })
    const p2 = withCookieLock('sid1', async () => {
      order.push('start2')
      order.push('end2')
    })
    await Promise.all([p1, p2])
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2'])
  })

  it('different sessionIds do not block each other', async () => {
    const order = []
    const p1 = withCookieLock('idA', async () => {
      await Promise.resolve() // yield first so idB runs immediately
      order.push('A')
    })
    const p2 = withCookieLock('idB', async () => {
      order.push('B')
    })
    await Promise.all([p1, p2])
    // B runs immediately (no wait) while A yields; so B should appear before A
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('A'))
  })

  it('forwards the return value from the callback', async () => {
    const result = await withCookieLock('retval', async () => 42)
    expect(result).toBe(42)
  })

  it('propagates errors from the callback and releases the lock', async () => {
    await expect(
      withCookieLock('errlock', async () => { throw new Error('boom') })
    ).rejects.toThrow('boom')

    // Lock must be released — subsequent call must not deadlock
    const result = await withCookieLock('errlock', async () => 'ok')
    expect(result).toBe('ok')
  })
})
