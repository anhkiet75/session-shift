#!/usr/bin/env node
// validate-locales.mjs — Offline, dependency-free validator for `src/_locales`.
//
// Checks: locale directory allowlist (exact 55-locale set), catalog file
// safety (no symlinks/extra files), JSON/schema validity, key parity against
// English, placeholder parity, manifest __MSG_ token resolution, rejection of
// bidi/default-ignorable control characters in message text, and
// translation-quality.json's honest review-tier registry.
//
// Reads only `src/lib/locale-data.json` (the allowlist/registry), the
// `_locales` tree + `manifest.json`, and `_locales/translation-quality.json`
// — no TypeScript parsing.

import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const LOCALES_DIR = path.join(SRC, '_locales')
export const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/

// Bidi overrides/isolates/marks and invisible-spoofing characters not approved
// in any message: LRE/RLE/PDF/LRO/RLO (U+202A-202E), LRI/RLI/FSI/PDI
// (U+2066-2069), LRM/RLM (U+200E/F), ALM (U+061C), zero-width space (U+200B),
// BOM (U+FEFF), soft hyphen (U+00AD).
// Deliberately EXCLUDES ZWNJ/ZWJ (U+200C/U+200D): required orthographic
// characters in Persian/Arabic/Indic scripts and emoji sequences, not spoofing.
export const DISALLOWED_CHAR_PATTERN =
  /[‪-‮⁦-⁩‎‏؜​﻿­]/

function loadLocaleData() {
  const raw = readFileSync(path.join(SRC, 'lib', 'locale-data.json'), 'utf8')
  return JSON.parse(raw)
}

function fail(errors, message) {
  errors.push(message)
}

/**
 * Rejects symlinks, non-regular files, and any entry outside the allowlist —
 * reusable against `src/_locales`, `dist/_locales`, or an extracted ZIP's
 * `_locales` so every delivery stage gets the same tree-safety guarantee.
 */
export function checkTreeSafety(errors, allowedLocales, localesDir = LOCALES_DIR) {
  let entries
  try {
    entries = readdirSync(localesDir, { withFileTypes: true })
  } catch {
    fail(errors, `_locales directory missing: ${localesDir}`)
    return
  }

  for (const entry of entries) {
    const entryPath = path.join(localesDir, entry.name)
    const stat = lstatSync(entryPath)
    if (stat.isSymbolicLink()) {
      fail(errors, `_locales/${entry.name}: symlinks are not allowed`)
      continue
    }
    if (!stat.isDirectory()) {
      // `translation-quality.json` is the one approved regular file at the
      // `_locales` root, sitting alongside the locale directories.
      if (entry.name !== 'translation-quality.json' || !stat.isFile()) {
        fail(errors, `_locales/${entry.name}: unexpected non-directory entry`)
      }
      continue
    }
    if (!allowedLocales.includes(entry.name)) {
      fail(errors, `_locales/${entry.name}: not in the supported-locale allowlist`)
      continue
    }

    const localeEntries = readdirSync(entryPath, { withFileTypes: true })
    for (const file of localeEntries) {
      const filePath = path.join(entryPath, file.name)
      const fstat = lstatSync(filePath)
      if (fstat.isSymbolicLink()) {
        fail(errors, `_locales/${entry.name}/${file.name}: symlinks are not allowed`)
      } else if (file.name !== 'messages.json' || !fstat.isFile()) {
        fail(errors, `_locales/${entry.name}/${file.name}: unexpected catalog-tree entry (only messages.json allowed)`)
      }
    }
  }

  // Phase 5 completes the exact 55-locale set: every allowlisted locale must
  // be present, and no unsupported extras (checked above) are allowed.
  for (const locale of allowedLocales) {
    if (!entries.some((e) => e.name === locale)) {
      fail(errors, `_locales/${locale} is in the supported-locale allowlist but missing`)
    }
  }
}

/**
 * Loads and parses `translation-quality.json`. Returns `null` (and records an
 * error) on a missing file or invalid JSON — callers must treat `null` as
 * "cannot validate further", not as an empty-but-valid registry.
 */
export function loadQualityData(errors) {
  let raw
  try {
    raw = readFileSync(path.join(LOCALES_DIR, 'translation-quality.json'), 'utf8')
  } catch {
    fail(errors, 'translation-quality.json missing from _locales')
    return null
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    fail(errors, `translation-quality.json is not valid JSON (${e.message})`)
    return null
  }
}

/**
 * Validates an already-parsed `translation-quality.json` shape: one honest
 * tier entry per supported locale, `reviewed` requires recorded
 * reviewer/date evidence, and every critical/eligible key actually exists in
 * the English catalog.
 */
export function validateQualityMetadata(errors, quality, supportedLocales, englishKeys) {
  const criticalKeys = Array.isArray(quality.criticalKeys) ? quality.criticalKeys : null
  if (!criticalKeys) {
    fail(errors, 'translation-quality.json: "criticalKeys" must be an array')
  } else {
    for (const key of criticalKeys) {
      if (!englishKeys.has(key)) {
        fail(errors, `translation-quality.json: criticalKeys entry "${key}" is not a real English catalog key`)
      }
    }
  }

  const locales = quality.locales
  if (typeof locales !== 'object' || locales === null || Array.isArray(locales)) {
    fail(errors, 'translation-quality.json: "locales" must be an object')
    return
  }

  for (const locale of supportedLocales) {
    const entry = locales[locale]
    if (!entry) {
      fail(errors, `translation-quality.json: missing quality entry for locale "${locale}"`)
      continue
    }
    if (!['source', 'beta', 'reviewed'].includes(entry.tier)) {
      fail(errors, `translation-quality.json.${locale}: invalid tier "${entry.tier}"`)
    }
    if (entry.tier === 'reviewed') {
      if (!entry.reviewer) fail(errors, `translation-quality.json.${locale}: tier "reviewed" requires a non-empty reviewer`)
      if (!entry.reviewedAt) fail(errors, `translation-quality.json.${locale}: tier "reviewed" requires a non-empty reviewedAt`)
    } else if (entry.reviewer || entry.reviewedAt) {
      fail(errors, `translation-quality.json.${locale}: reviewer/reviewedAt must be null unless tier is "reviewed" (no unearned review claim)`)
    }
    const eligible = Array.isArray(entry.criticalKeyEligible) ? entry.criticalKeyEligible : []
    for (const key of eligible) {
      if (criticalKeys && !criticalKeys.includes(key)) {
        fail(errors, `translation-quality.json.${locale}: criticalKeyEligible entry "${key}" is not in criticalKeys`)
      }
    }
  }

  for (const locale of Object.keys(locales)) {
    if (!supportedLocales.includes(locale)) {
      fail(errors, `translation-quality.json: unknown locale "${locale}" not in the supported-locale allowlist`)
    }
  }
}

function loadCatalog(errors, locale) {
  const filePath = path.join(LOCALES_DIR, locale, 'messages.json')
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    fail(errors, `${locale}: messages.json missing or unreadable`)
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    fail(errors, `${locale}: messages.json is not valid JSON (${e.message})`)
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(errors, `${locale}: messages.json must be a flat object of key -> entry`)
    return null
  }
  return parsed
}

export function declaredPlaceholderNames(entry) {
  return entry.placeholders ? Object.keys(entry.placeholders) : []
}

export function referencedPlaceholderNames(message) {
  const names = new Set()
  const re = /\$([A-Za-z0-9_]+)\$/g
  let m
  while ((m = re.exec(message))) {
    const name = m[1]
    if (name === name.toUpperCase() && /^\d+$/.test(name)) continue // numeric $1$ Chrome-style, unlikely here
    names.add(name.toLowerCase())
  }
  return [...names]
}

export function validateCatalogEntries(errors, locale, catalog) {
  for (const [key, entry] of Object.entries(catalog)) {
    if (key.startsWith('@@')) {
      fail(errors, `${locale}.${key}: '@@' prefix is reserved by Chrome`)
      continue
    }
    if (!KEY_PATTERN.test(key)) {
      fail(errors, `${locale}.${key}: invalid key (must match ${KEY_PATTERN})`)
      continue
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(errors, `${locale}.${key}: entry must be an object with a "message" field`)
      continue
    }
    if (typeof entry.message !== 'string' || entry.message.length === 0) {
      fail(errors, `${locale}.${key}: message must be a non-empty string`)
      continue
    }
    if (DISALLOWED_CHAR_PATTERN.test(entry.message)) {
      fail(errors, `${locale}.${key}: message contains an unapproved bidi/default-ignorable control character`)
    }

    const declared = declaredPlaceholderNames(entry)
    const referenced = referencedPlaceholderNames(entry.message)
    for (const name of referenced) {
      if (!declared.includes(name)) {
        fail(errors, `${locale}.${key}: message references $${name}$ with no matching "placeholders" declaration`)
      }
    }
    for (const name of declared) {
      if (!referenced.includes(name.toLowerCase())) {
        fail(errors, `${locale}.${key}: declared placeholder "${name}" is unused in the message`)
      }
    }
  }
}

export function validateKeyParity(errors, locale, catalog, englishKeys) {
  const localeKeys = new Set(Object.keys(catalog))
  for (const key of englishKeys) {
    if (!localeKeys.has(key)) fail(errors, `${locale}: missing key "${key}" present in English`)
  }
  for (const key of localeKeys) {
    if (!englishKeys.has(key)) fail(errors, `${locale}: unknown key "${key}" not present in English (registry drift)`)
  }
}

export function validatePlaceholderParity(errors, locale, catalog, englishCatalog) {
  for (const [key, entry] of Object.entries(catalog)) {
    const englishEntry = englishCatalog[key]
    if (!englishEntry) continue // already reported by key-parity check
    const localeDeclared = new Set(declaredPlaceholderNames(entry))
    const englishDeclared = new Set(declaredPlaceholderNames(englishEntry))
    for (const name of englishDeclared) {
      if (!localeDeclared.has(name)) {
        fail(errors, `${locale}.${key}: missing placeholder "${name}" declared in English (parity/reorder drift)`)
      }
    }
    for (const name of localeDeclared) {
      if (!englishDeclared.has(name)) {
        fail(errors, `${locale}.${key}: extra placeholder "${name}" not declared in English`)
      }
    }
  }
}

function validateManifestTokens(errors, englishCatalog, manifestOnlyKeys) {
  const manifestPath = path.join(SRC, 'manifest.json')
  const manifestRaw = readFileSync(manifestPath, 'utf8')
  const tokenPattern = /__MSG_([A-Za-z0-9_@]+)__/g
  const referenced = new Set()
  let m
  while ((m = tokenPattern.exec(manifestRaw))) referenced.add(m[1])

  for (const key of referenced) {
    if (!englishCatalog[key]) {
      fail(errors, `manifest.json: __MSG_${key}__ has no matching English catalog entry`)
      continue
    }
    if (!manifestOnlyKeys.includes(key)) {
      fail(errors, `manifest.json: __MSG_${key}__ is not in the manifest-only key registry`)
    }
  }
}

/** Runs every check against the real `src/_locales` tree. No process I/O. */
export function main() {
  const errors = []
  const data = loadLocaleData()

  checkTreeSafety(errors, data.supportedLocales)

  const englishCatalog = loadCatalog(errors, data.defaultLocale)
  if (!englishCatalog) {
    return { ok: false, errors, localeCount: 0, keyCount: 0 }
  }
  validateCatalogEntries(errors, data.defaultLocale, englishCatalog)
  validateManifestTokens(errors, englishCatalog, data.manifestOnlyKeys)

  const englishKeys = new Set(Object.keys(englishCatalog))
  const qualityData = loadQualityData(errors)
  if (qualityData) validateQualityMetadata(errors, qualityData, data.supportedLocales, englishKeys)

  let presentLocales
  try {
    presentLocales = readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => data.supportedLocales.includes(name))
  } catch {
    presentLocales = []
  }

  for (const locale of presentLocales) {
    if (locale === data.defaultLocale) continue
    const catalog = loadCatalog(errors, locale)
    if (!catalog) continue
    validateCatalogEntries(errors, locale, catalog)
    validateKeyParity(errors, locale, catalog, englishKeys)
    validatePlaceholderParity(errors, locale, catalog, englishCatalog)
  }

  return { ok: errors.length === 0, errors, localeCount: presentLocales.length, keyCount: englishKeys.size }
}

function runCli() {
  const result = main()
  if (!result.ok) {
    console.error(`Locale validation failed (${result.errors.length} issue(s)):\n` + result.errors.map((e) => `  - ${e}`).join('\n'))
    process.exit(1)
  }
  console.log(`Locale validation passed: ${result.localeCount} locale(s), ${result.keyCount} key(s).`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli()
