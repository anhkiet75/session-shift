// localization-catalog.test.ts — Catalog and reference contract tests.
// Verifies the English catalog is complete, the 55-locale metadata table is
// lossless, and the validator rejects the documented failure classes.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SUPPORTED_LOCALES,
  RTL_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_METADATA,
  MANIFEST_ONLY_KEYS,
  MESSAGE_PLACEHOLDERS,
  CRITICAL_MESSAGE_KEYS,
  isSupportedLocale,
  directionFor,
} from '../lib/localization-types.js'
import type { MessageKey, ChromeMessageCatalog, TranslationQualityData } from '../lib/localization-types.js'
import {
  main as runValidator,
  validateCatalogEntries,
  validateKeyParity,
  validatePlaceholderParity,
  validateQualityMetadata,
  checkTreeSafety,
  DISALLOWED_CHAR_PATTERN,
} from '../scripts/validate-locales.mjs'

const ROOT = process.cwd()
const localeData = JSON.parse(readFileSync(resolve(ROOT, 'src/lib/locale-data.json'), 'utf8'))
const englishCatalog: ChromeMessageCatalog = JSON.parse(
  readFileSync(resolve(ROOT, 'src/_locales/en/messages.json'), 'utf8'),
)
const qualityData: TranslationQualityData = JSON.parse(
  readFileSync(resolve(ROOT, 'src/_locales/translation-quality.json'), 'utf8'),
)

describe('locale allowlist single source of truth', () => {
  it('locale-data.json matches localization-types.ts exactly (55 codes)', () => {
    expect(SUPPORTED_LOCALES.length).toBe(55)
    expect([...localeData.supportedLocales].sort()).toEqual([...SUPPORTED_LOCALES].sort())
    expect([...localeData.rtlLocales].sort()).toEqual([...RTL_LOCALES].sort())
    expect(localeData.defaultLocale).toBe(DEFAULT_LOCALE)
    expect([...localeData.manifestOnlyKeys].sort()).toEqual([...MANIFEST_ONLY_KEYS].sort())
  })

  it.each(SUPPORTED_LOCALES as readonly string[])('%s: folder/tag/direction round trip is lossless', (code) => {
    expect(isSupportedLocale(code)).toBe(true)
    if (!isSupportedLocale(code)) return
    const meta = LOCALE_METADATA[code]
    expect(meta.code).toBe(code)
    expect(meta.languageTag).toBe(code.replace('_', '-'))
    expect(meta.direction).toBe(directionFor(code))
    const expectedDirection = (RTL_LOCALES as readonly string[]).includes(code) ? 'rtl' : 'ltr'
    expect(meta.direction).toBe(expectedDirection)
  })

  it('only ar/fa/he are RTL', () => {
    expect([...RTL_LOCALES].sort()).toEqual(['ar', 'fa', 'he'])
  })
})

describe('canonical English catalog', () => {
  const messageKeys = Object.keys(englishCatalog) as MessageKey[]

  it('has a non-empty message for every catalog key', () => {
    for (const key of messageKeys) {
      expect(englishCatalog[key].message.length).toBeGreaterThan(0)
    }
  })

  it('every manifest-only key resolves in English', () => {
    for (const key of MANIFEST_ONLY_KEYS) {
      expect(englishCatalog[key]).toBeDefined()
      expect(englishCatalog[key].message.length).toBeGreaterThan(0)
    }
  })

  it('declares placeholders consistent with localization-types registry', () => {
    for (const key of Object.keys(MESSAGE_PLACEHOLDERS) as MessageKey[]) {
      const names = MESSAGE_PLACEHOLDERS[key] ?? []
      const entry = englishCatalog[key]
      expect(entry, `missing catalog entry for ${key}`).toBeDefined()
      const declared = Object.keys(entry.placeholders ?? {})
      expect(declared.sort()).toEqual([...names].sort())
    }
  })

  it('passes the real validator with zero errors', () => {
    const result = runValidator()
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })
})

describe('translation-quality.json — honest review-tier registry', () => {
  it('has exactly one entry per supported locale, no extras, no gaps', () => {
    expect(Object.keys(qualityData.locales).sort()).toEqual([...SUPPORTED_LOCALES].sort())
  })

  it('every criticalKeys entry is a real English catalog key', () => {
    for (const key of qualityData.criticalKeys) {
      expect(englishCatalog[key], `criticalKeys entry "${key}" missing from English`).toBeDefined()
    }
  })

  it('criticalKeys matches the localization-types.ts CRITICAL_MESSAGE_KEYS registry exactly', () => {
    expect([...qualityData.criticalKeys].sort()).toEqual([...CRITICAL_MESSAGE_KEYS].sort())
  })

  it('English is tier "source", never claimed as a review of itself', () => {
    expect(qualityData.locales[DEFAULT_LOCALE].tier).toBe('source')
  })

  it('no locale claims "reviewed" without a recorded reviewer and reviewedAt (no unearned claim)', () => {
    for (const [locale, entry] of Object.entries(qualityData.locales)) {
      if (entry.tier === 'reviewed') {
        expect(entry.reviewer, `${locale}: reviewed requires a reviewer`).toBeTruthy()
        expect(entry.reviewedAt, `${locale}: reviewed requires a reviewedAt date`).toBeTruthy()
      } else {
        expect(entry.reviewer, `${locale}: non-reviewed tier must not carry a reviewer`).toBeNull()
        expect(entry.reviewedAt, `${locale}: non-reviewed tier must not carry a reviewedAt`).toBeNull()
      }
    }
  })

  it('every criticalKeyEligible entry is one of the declared criticalKeys', () => {
    for (const [locale, entry] of Object.entries(qualityData.locales)) {
      for (const key of entry.criticalKeyEligible) {
        expect(qualityData.criticalKeys, `${locale}: criticalKeyEligible "${key}" not in criticalKeys`).toContain(key)
      }
    }
  })

  it('the real validator accepts the committed translation-quality.json with zero errors', () => {
    const errors: string[] = []
    validateQualityMetadata(errors, qualityData, [...SUPPORTED_LOCALES], new Set(Object.keys(englishCatalog)))
    expect(errors).toEqual([])
  })
})

describe('tree safety — translation-quality.json is the one approved root-level file', () => {
  it('checkTreeSafety accepts translation-quality.json without flagging it as an unexpected entry', () => {
    const errors: string[] = []
    checkTreeSafety(errors, [...SUPPORTED_LOCALES])
    expect(errors.filter((e) => e.includes('translation-quality.json'))).toEqual([])
  })
})

describe('validator fixtures', () => {
  it('rejects an empty message', () => {
    const errors: string[] = []
    validateCatalogEntries(errors, 'fixture', { key: { message: '' } })
    expect(errors.some((e) => e.includes('non-empty string'))).toBe(true)
  })

  it('rejects an invalid key', () => {
    const errors: string[] = []
    validateCatalogEntries(errors, 'fixture', { '1bad-key': { message: 'x' } })
    expect(errors.some((e) => e.includes('invalid key'))).toBe(true)
  })

  it('rejects a reserved @@ key', () => {
    const errors: string[] = []
    validateCatalogEntries(errors, 'fixture', { '@@reserved': { message: 'x' } })
    expect(errors.some((e) => e.includes("'@@' prefix"))).toBe(true)
  })

  it('rejects placeholder drift: referenced but undeclared', () => {
    const errors: string[] = []
    validateCatalogEntries(errors, 'fixture', { greet: { message: 'Hi $name$' } })
    expect(errors.some((e) => e.includes('no matching "placeholders" declaration'))).toBe(true)
  })

  it('rejects placeholder drift: declared but unused', () => {
    const errors: string[] = []
    validateCatalogEntries(errors, 'fixture', {
      greet: { message: 'Hi', placeholders: { name: { content: '$1' } } },
    })
    expect(errors.some((e) => e.includes('is unused in the message'))).toBe(true)
  })

  it('rejects an unapproved bidi control character', () => {
    expect(DISALLOWED_CHAR_PATTERN.test('safe text')).toBe(false)
    expect(DISALLOWED_CHAR_PATTERN.test('bad‮text')).toBe(true)
    const errors: string[] = []
    validateCatalogEntries(errors, 'fixture', { key: { message: 'bad‮text' } })
    expect(errors.some((e) => e.includes('bidi/default-ignorable'))).toBe(true)
  })

  it('rejects missing/extra keys against English (parity)', () => {
    const english = new Set(['a', 'b'])
    const errorsMissing: string[] = []
    validateKeyParity(errorsMissing, 'fixture', { a: { message: 'x' } }, english)
    expect(errorsMissing.some((e) => e.includes('missing key "b"'))).toBe(true)

    const errorsExtra: string[] = []
    validateKeyParity(errorsExtra, 'fixture', { a: { message: 'x' }, b: { message: 'y' }, c: { message: 'z' } }, english)
    expect(errorsExtra.some((e) => e.includes('unknown key "c"'))).toBe(true)
  })

  it('rejects placeholder reorder/parity drift across locales', () => {
    const english: ChromeMessageCatalog = { greet: { message: 'Hi $name$', placeholders: { name: { content: '$1' } } } }
    const errors: string[] = []
    validatePlaceholderParity(errors, 'fixture', { greet: { message: 'Bonjour' } }, english)
    expect(errors.some((e) => e.includes('missing placeholder "name"'))).toBe(true)
  })

  it('rejects a "reviewed" claim without reviewer/reviewedAt evidence', () => {
    const errors: string[] = []
    validateQualityMetadata(
      errors,
      { criticalKeys: [], locales: { en: { tier: 'reviewed', reviewer: null, reviewedAt: null, criticalKeyEligible: [] } } },
      ['en'],
      new Set(['tabSettings']),
    )
    expect(errors.some((e) => e.includes('requires a non-empty reviewer'))).toBe(true)
    expect(errors.some((e) => e.includes('requires a non-empty reviewedAt'))).toBe(true)
  })

  it('rejects a beta locale carrying leftover reviewer/reviewedAt fields (no partial-credit claim)', () => {
    const errors: string[] = []
    validateQualityMetadata(
      errors,
      { criticalKeys: [], locales: { de: { tier: 'beta', reviewer: 'someone', reviewedAt: '2026-01-01', criticalKeyEligible: [] } } },
      ['de'],
      new Set(['tabSettings']),
    )
    expect(errors.some((e) => e.includes('must be null unless tier is "reviewed"'))).toBe(true)
  })

  it('rejects a criticalKeys entry that is not a real English catalog key', () => {
    const errors: string[] = []
    validateQualityMetadata(
      errors,
      { criticalKeys: ['__not_a_real_key__'], locales: { en: { tier: 'source', reviewer: null, reviewedAt: null, criticalKeyEligible: [] } } },
      ['en'],
      new Set(['tabSettings']),
    )
    expect(errors.some((e) => e.includes('is not a real English catalog key'))).toBe(true)
  })

  it('rejects criticalKeyEligible referencing a key outside criticalKeys', () => {
    const errors: string[] = []
    validateQualityMetadata(
      errors,
      {
        criticalKeys: ['deleteTitle'],
        locales: { de: { tier: 'beta', reviewer: null, reviewedAt: null, criticalKeyEligible: ['resetButton'] } },
      },
      ['de'],
      new Set(['deleteTitle', 'resetButton']),
    )
    expect(errors.some((e) => e.includes('is not in criticalKeys'))).toBe(true)
  })

  it('rejects a missing quality entry for a supported locale', () => {
    const errors: string[] = []
    validateQualityMetadata(errors, { criticalKeys: [], locales: {} }, ['de'], new Set())
    expect(errors.some((e) => e.includes('missing quality entry for locale "de"'))).toBe(true)
  })
})
