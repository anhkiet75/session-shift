import { describe, it, expect } from 'vitest'
import { parseSetCookie, serializeCookieHeader, parseCookieString, cookieKey } from '../lib/cookie-parser.js'

describe('parseSetCookie', () => {
  it('parses basic name=value with defaults from URL', () => {
    const result = parseSetCookie('token=abc123', 'https://github.com/path')
    expect(result.name).toBe('token')
    expect(result.value).toBe('abc123')
    expect(result.domain).toBe('github.com')
    expect(result.path).toBe('/path')
    expect(result.secure).toBe(false)
    expect(result.httpOnly).toBe(false)
    expect(result.expires).toBeNull()
  })

  it('parses Secure and HttpOnly flags', () => {
    const result = parseSetCookie('sid=xyz; Secure; HttpOnly; Path=/', 'https://example.com/')
    expect(result.secure).toBe(true)
    expect(result.httpOnly).toBe(true)
    expect(result.path).toBe('/')
  })

  it('parses Max-Age into future timestamp', () => {
    const before = Date.now()
    const result = parseSetCookie('x=1; Max-Age=3600', 'https://example.com/')
    expect(result.expires).toBeGreaterThanOrEqual(before + 3600 * 1000 - 10)
    expect(result.expires).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 10)
  })

  it('parses Expires header', () => {
    const result = parseSetCookie('x=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT', 'https://example.com/')
    expect(result.expires).toBeGreaterThan(Date.now())
  })

  it('Max-Age=0 sets expires to 0 (deletion signal)', () => {
    const result = parseSetCookie('x=1; Max-Age=0', 'https://example.com/')
    expect(result.expires).toBe(0)
  })

  it('Max-Age takes precedence over Expires', () => {
    const before = Date.now()
    const result = parseSetCookie(
      'x=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Max-Age=60',
      'https://example.com/'
    )
    expect(result.expires).toBeLessThan(before + 65_000)
  })

  it('parses explicit Domain attribute with dot prefix', () => {
    const result = parseSetCookie('x=1; Domain=example.com', 'https://sub.example.com/')
    expect(result.domain).toBe('.example.com')
  })

  it('does not double-dot when Domain already starts with dot', () => {
    const result = parseSetCookie('x=1; Domain=.example.com', 'https://example.com/')
    expect(result.domain).toBe('.example.com')
  })

  it('parses SameSite attribute', () => {
    const result = parseSetCookie('x=1; SameSite=Lax', 'https://example.com/')
    expect(result.sameSite).toBe('Lax')
  })

  it('returns null when name=value is missing =', () => {
    expect(parseSetCookie('invalidcookie', 'https://example.com/')).toBeNull()
  })

  it('handles empty value', () => {
    const result = parseSetCookie('token=', 'https://example.com/')
    expect(result.name).toBe('token')
    expect(result.value).toBe('')
  })

  it('preserves = in value (JWT tokens)', () => {
    const result = parseSetCookie('jwt=abc.def=ghi', 'https://example.com/')
    expect(result.value).toBe('abc.def=ghi')
  })

  it('handles invalid requestUrl gracefully', () => {
    const result = parseSetCookie('x=1', 'not-a-url')
    expect(result.name).toBe('x')
    expect(result.domain).toBeNull()
    expect(result.path).toBeNull()
  })
})

describe('serializeCookieHeader', () => {
  it('serializes store to cookie string', () => {
    const store = {
      token: { value: 'abc', expires: null },
      session: { value: 'xyz', expires: null },
    }
    const result = serializeCookieHeader(store)
    expect(result).toContain('token=abc')
    expect(result).toContain('session=xyz')
  })

  it('returns empty string for empty store', () => {
    expect(serializeCookieHeader({})).toBe('')
  })

  it('excludes expired cookies', () => {
    const store = {
      old: { value: 'x', expires: Date.now() - 1000 },
      valid: { value: 'y', expires: null },
    }
    const result = serializeCookieHeader(store)
    expect(result).not.toContain('old=')
    expect(result).toContain('valid=y')
  })

  it('includes cookies with future expires', () => {
    const store = {
      future: { value: 'z', expires: Date.now() + 100_000 },
    }
    expect(serializeCookieHeader(store)).toContain('future=z')
  })

  it('includes cookies with expires=null (session cookies)', () => {
    const store = { sess: { value: 'v', expires: null } }
    expect(serializeCookieHeader(store)).toBe('sess=v')
  })
})

describe('parseCookieString', () => {
  it('splits cookie string into name/value pairs', () => {
    const map = parseCookieString('a=1; b=2; c=3')
    expect(map.size).toBe(3)
    expect(map.get('a')).toBe('1')
    expect(map.get('b')).toBe('2')
    expect(map.get('c')).toBe('3')
  })

  it('returns empty Map for empty string', () => {
    expect(parseCookieString('').size).toBe(0)
  })

  it('returns empty Map for null/undefined', () => {
    expect(parseCookieString(null).size).toBe(0)
  })

  it('preserves = in values', () => {
    const map = parseCookieString('jwt=abc.def=ghi')
    expect(map.get('jwt')).toBe('abc.def=ghi')
  })

  it('handles single cookie', () => {
    const map = parseCookieString('only=one')
    expect(map.get('only')).toBe('one')
  })
})

describe('serializeCookieHeader — security options', () => {
  it('excludes httpOnly cookies when excludeHttpOnly is true (H1)', () => {
    const store = {
      visible: { value: 'a', expires: null, httpOnly: false },
      secret:  { value: 'b', expires: null, httpOnly: true },
    }
    const result = serializeCookieHeader(store, { excludeHttpOnly: true })
    expect(result).toContain('visible=a')
    expect(result).not.toContain('secret=b')
  })

  it('includes httpOnly cookies on the network (DNR) path — no option', () => {
    const store = {
      visible: { value: 'a', expires: null, httpOnly: false },
      secret:  { value: 'b', expires: null, httpOnly: true },
    }
    const result = serializeCookieHeader(store)
    expect(result).toContain('visible=a')
    expect(result).toContain('secret=b')
  })

  it('excludes Secure cookies when excludeSecure is true (M2 HTTP-bound)', () => {
    const store = {
      normal: { value: 'x', expires: null, secure: false },
      locked: { value: 'y', expires: null, secure: true },
    }
    const result = serializeCookieHeader(store, { excludeSecure: true })
    expect(result).toContain('normal=x')
    expect(result).not.toContain('locked=y')
  })

  it('includes all cookies when no options are set', () => {
    const store = {
      a: { value: '1', expires: null, httpOnly: true, secure: true },
      b: { value: '2', expires: null },
    }
    const result = serializeCookieHeader(store)
    expect(result).toContain('a=1')
    expect(result).toContain('b=2')
  })
})

describe('parseSetCookie — Domain validation (M5)', () => {
  it('rejects cross-domain Domain attribute', () => {
    expect(parseSetCookie('SID=val; Domain=evil.com', 'https://victim.com/')).toBeNull()
  })

  it('accepts Domain matching the request host exactly', () => {
    const result = parseSetCookie('SID=val; Domain=example.com', 'https://example.com/')
    expect(result).not.toBeNull()
    expect(result.domain).toBe('.example.com')
  })

  it('accepts Domain that is a parent of the request host', () => {
    const result = parseSetCookie('SID=val; Domain=example.com', 'https://api.example.com/')
    expect(result).not.toBeNull()
    expect(result.domain).toBe('.example.com')
  })

  it('rejects single-label Domain attribute', () => {
    expect(parseSetCookie('SID=val; Domain=corp', 'https://corp/')).toBeNull()
  })

  it('accepts localhost Domain for local-dev cookies', () => {
    const result = parseSetCookie('SID=val; Domain=localhost', 'http://localhost/')
    expect(result).not.toBeNull()
  })
})

describe('cookieKey', () => {
  it('builds composite key with pipe separators', () => {
    expect(cookieKey('token', 'github.com', '/')).toBe('token|github.com|/')
  })

  it('includes all three components', () => {
    const key = cookieKey('sid', '.example.com', '/app')
    expect(key).toContain('sid')
    expect(key).toContain('.example.com')
    expect(key).toContain('/app')
  })
})
