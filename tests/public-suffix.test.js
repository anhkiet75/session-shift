import { describe, it, expect } from 'vitest'
import { getEtld1, isPublicSuffix } from '../lib/public-suffix.js'

describe('getEtld1', () => {
  it('collapses a subdomain to its registrable domain', () => {
    expect(getEtld1('www.google.com')).toBe('google.com')
    expect(getEtld1('accounts.google.com')).toBe('google.com')
  })

  it('returns the host unchanged when it is already the registrable domain', () => {
    expect(getEtld1('google.com')).toBe('google.com')
    expect(getEtld1('foo.co.uk')).toBe('foo.co.uk')
  })

  it('collapses deep subdomains under a multi-label public suffix', () => {
    expect(getEtld1('a.b.foo.co.uk')).toBe('foo.co.uk')
  })

  it('passes through IP literals', () => {
    expect(getEtld1('192.168.0.1')).toBe('192.168.0.1')
  })

  it('passes through localhost and single-label hosts', () => {
    expect(getEtld1('localhost')).toBe('localhost')
    expect(getEtld1('corp')).toBe('corp')
  })

  it('strips a single trailing dot and lowercases', () => {
    expect(getEtld1('google.com.')).toBe('google.com')
    expect(getEtld1('WWW.Google.COM')).toBe('google.com')
  })

  it('handles PSL wildcard rules (*.ck)', () => {
    // `*.ck` => public suffix is `bar.ck`, so eTLD+1 of foo.bar.ck is foo.bar.ck
    expect(getEtld1('foo.bar.ck')).toBe('foo.bar.ck')
  })

  it('handles PSL exception rules (!www.ck)', () => {
    // `!www.ck` exception => public suffix is `ck`, so eTLD+1 of www.ck is www.ck
    expect(getEtld1('www.ck')).toBe('www.ck')
  })

  it('uses private suffix rules for hosted tenant domains', () => {
    expect(getEtld1('foo.github.io')).toBe('foo.github.io')
    expect(getEtld1('bar.pages.dev')).toBe('bar.pages.dev')
  })
})

describe('isPublicSuffix', () => {
  it('is true for multi-label public suffixes', () => {
    expect(isPublicSuffix('co.uk')).toBe(true)
    expect(isPublicSuffix('co.il')).toBe(true)
  })

  it('is true for a top-level public suffix', () => {
    expect(isPublicSuffix('com')).toBe(true)
  })

  it('is false for a registrable domain', () => {
    expect(isPublicSuffix('google.com')).toBe(false)
    expect(isPublicSuffix('foo.co.uk')).toBe(false)
  })

  it('is true for private public suffixes', () => {
    expect(isPublicSuffix('github.io')).toBe(true)
    expect(isPublicSuffix('pages.dev')).toBe(true)
  })
})
