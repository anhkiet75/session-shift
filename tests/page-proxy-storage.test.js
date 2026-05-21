import { describe, it, expect, beforeEach } from 'vitest'
import { makeStorageProxy } from '../lib/storage-proxy.js'

function makeFakeStorage() {
  const data = {}
  return {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => { data[k] = String(v) },
    removeItem: (k) => { delete data[k] },
    key: (i) => Object.keys(data)[i] ?? null,
    get length() { return Object.keys(data).length },
  }
}

describe('makeStorageProxy', () => {
  let real, proxy

  beforeEach(() => {
    real = makeFakeStorage()
    proxy = makeStorageProxy(real, '__ext_session_abc_')
  })

  it('setItem stores under prefixed key', () => {
    proxy.setItem('user', 'alice')
    expect(real.getItem('__ext_session_abc_user')).toBe('alice')
  })

  it('getItem reads only its own prefixed key', () => {
    real.setItem('__ext_session_abc_user', 'alice')
    real.setItem('other_user', 'bob')
    expect(proxy.getItem('user')).toBe('alice')
    expect(proxy.getItem('other_user')).toBeNull()
  })

  it('getItem returns null for missing key', () => {
    expect(proxy.getItem('missing')).toBeNull()
  })

  it('removeItem deletes only the prefixed key', () => {
    real.setItem('__ext_session_abc_x', '1')
    real.setItem('other_x', '2')
    proxy.removeItem('x')
    expect(real.getItem('__ext_session_abc_x')).toBeNull()
    expect(real.getItem('other_x')).toBe('2')
  })

  it('clear removes only prefixed keys', () => {
    real.setItem('__ext_session_abc_a', '1')
    real.setItem('__ext_session_abc_b', '2')
    real.setItem('unrelated', '3')
    proxy.clear()
    expect(real.getItem('__ext_session_abc_a')).toBeNull()
    expect(real.getItem('__ext_session_abc_b')).toBeNull()
    expect(real.getItem('unrelated')).toBe('3')
  })

  it('length counts only prefixed keys', () => {
    real.setItem('__ext_session_abc_a', '1')
    real.setItem('__ext_session_abc_b', '2')
    real.setItem('other', '3')
    expect(proxy.length).toBe(2)
  })

  it('length is 0 for empty session', () => {
    expect(proxy.length).toBe(0)
  })

  it('key returns unprefixed key at index', () => {
    real.setItem('__ext_session_abc_first', 'x')
    expect(proxy.key(0)).toBe('first')
  })

  it('key returns null when index out of range', () => {
    expect(proxy.key(99)).toBeNull()
  })

  it('two proxies with different prefixes are fully isolated', () => {
    const proxy2 = makeStorageProxy(real, '__ext_session_xyz_')
    proxy.setItem('k', 'v1')
    proxy2.setItem('k', 'v2')
    expect(proxy.getItem('k')).toBe('v1')
    expect(proxy2.getItem('k')).toBe('v2')
    expect(proxy.length).toBe(1)
    expect(proxy2.length).toBe(1)
  })

  it('setItem coerces value to string', () => {
    proxy.setItem('num', 42)
    expect(proxy.getItem('num')).toBe('42')
  })
})
