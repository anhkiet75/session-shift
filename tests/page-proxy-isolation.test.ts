import { required } from './helpers/assert.js'
const proxyScript = '../src/page-api-proxy.ts'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const NONCE = 'n1'
const SESSION = 'session_iso'
const PREFIX = `__ext_${SESSION}_`

function deliver(data: unknown) {
  window.dispatchEvent(new MessageEvent('message', {
    data,
    source: window,
    origin: window.location.origin,
  }))
}

async function loadProxy() {
  vi.resetModules()
  await import(proxyScript)
  deliver({ source: 'ext-content', action: 'initNonce', sessionId: SESSION, nonce: NONCE })
}

// Runs FIRST and loads the proxy exactly once (beforeAll). Re-importing the proxy
// per test stacks `storage` interceptors on the shared jsdom window; storageArea
// identity (`=== window.localStorage`) only holds against a single instance, which
// matches production (one MAIN-world injection per page).
describe('storage event remap (Phase 3 / 1.4, High #10)', () => {
  beforeAll(loadProxy)

  function dispatchRawStorage({ key, newValue, area }: {key: string; newValue: string; area?: Storage}) {
    const e = new StorageEvent('storage', { key, newValue, oldValue: null })
    try { Object.defineProperty(e, 'storageArea', { configurable: true, value: area }) } catch { /* noop */ }
    window.dispatchEvent(e)
  }

  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('strips the prefix and fires exactly one page-visible event', async () => {
    const seen: StorageEvent[] = []
    window.addEventListener('storage', (e) => seen.push(e))
    dispatchRawStorage({ key: `${PREFIX}token`, newValue: 'v' })
    await flush()
    expect(seen.length).toBe(1)
    expect(seen[0].key).toBe('token')
    expect(seen[0].newValue).toBe('v')
  })

  it('swallows another session / unprefixed writes', async () => {
    const seen: StorageEvent[] = []
    window.addEventListener('storage', (e) => seen.push(e))
    dispatchRawStorage({ key: '__ext_other_token', newValue: 'x' })
    dispatchRawStorage({ key: 'plain', newValue: 'y' })
    await flush()
    expect(seen.length).toBe(0)
  })

  it('synthetic storageArea === window.localStorage', async () => {
    let captured: StorageEvent | undefined
    window.addEventListener('storage', (e) => { captured = e })
    dispatchRawStorage({ key: `${PREFIX}k`, newValue: 'v' })
    await flush()
    expect(required(captured).storageArea).toBe(window.localStorage)
  })
})

describe('storage proxy identity + instanceof (Phase 3 / 1.4)', () => {
  beforeEach(loadProxy)

  it('localStorage is a stable singleton', () => {
    expect(window.localStorage).toBe(window.localStorage)
    expect(window.sessionStorage).toBe(window.sessionStorage)
  })

  it('localStorage instanceof Storage', () => {
    expect(window.localStorage instanceof Storage).toBe(true)
    expect(window.sessionStorage instanceof Storage).toBe(true)
  })

  it('setItem/getItem still prefix-isolate through the singleton', () => {
    window.localStorage.setItem('tok', 'abc')
    expect(window.localStorage.getItem('tok')).toBe('abc')
  })
})

describe('indexedDB.databases filtering (Phase 3 / 1.5)', () => {
  beforeEach(async () => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      writable: true,
      value: {
        open: vi.fn(),
        deleteDatabase: vi.fn(),
        databases: vi.fn(async () => [
          { name: `${PREFIX}app`, version: 1 },
          { name: '__ext_other_db', version: 1 },
          { name: 'bare', version: 1 },
        ]),
      },
    })
    await loadProxy()
  })

  afterEach(() => { Reflect.deleteProperty(window, 'indexedDB') })

  it('returns only this session DBs with the prefix stripped', async () => {
    const dbs = await window.indexedDB.databases()
    expect(dbs).toEqual([{ name: 'app', version: 1 }])
  })
})

describe('caches.match scoping (Phase 3 / 1.5)', () => {
  let caughtRequest: Request | null
  beforeEach(async () => {
    caughtRequest = null
    const sessionCache = { match: vi.fn(async (req) => { caughtRequest = req; return 'HIT' }) }
    const otherCache = { match: vi.fn(async () => 'WRONG') }
    Object.defineProperty(window, 'caches', {
      configurable: true,
      writable: true,
      value: {
        open: vi.fn(async (name) => (name === `${PREFIX}c` ? sessionCache : otherCache)),
        delete: vi.fn(),
        has: vi.fn(),
        keys: vi.fn(async () => [`${PREFIX}c`, '__ext_other_c', 'bare']),
        match: vi.fn(async () => 'GLOBAL_WRONG'),
      },
    })
    await loadProxy()
  })

  afterEach(() => { Reflect.deleteProperty(window, 'caches') })

  it('resolves only against this session prefixed caches', async () => {
    const hit = await window.caches.match('/x')
    expect(hit).toBe('HIT')
    expect(caughtRequest).toBe('/x')
  })
})

describe('inline makeStorageProxy parity with lib canonical (Phase 3, Crit #2)', () => {
  it('inline copy is byte-equivalent to lib/storage-proxy.ts (modulo prefix param/closure)', () => {
    const root = process.cwd()
    const inlineSrc = readFileSync(resolve(root, 'src/page-api-proxy.ts'), 'utf8')
    const libSrc = readFileSync(resolve(root, 'src/lib/storage-proxy.ts'), 'utf8')

    const body = (src: string) => {
      const start = src.indexOf('return {', src.indexOf('makeStorageProxy'))
      const end = src.indexOf('};', start)
      return src.slice(start + 'return {'.length, end)
    }
    // Strip TS type annotations, all whitespace, and commas (trailing-comma diff).
    const norm = (s: string) => s
      .replace(/:\s*(string\[\]|string|number)/g, '')
      .replace(/\s+/g, '')
      .replace(/,/g, '')

    expect(norm(body(inlineSrc))).toBe(norm(body(libSrc)))
  })
})
