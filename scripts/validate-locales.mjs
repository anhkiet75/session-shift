#!/usr/bin/env node
// validate-locales.mjs — Offline, dependency-free validator for `src/_locales`.
//
// Checks: locale directory allowlist, catalog file safety (no symlinks/extra
// files), JSON/schema validity, key parity against English, placeholder
// parity, manifest __MSG_ token resolution, and rejection of bidi/
// default-ignorable control characters in message text.
//
// Reads only `src/lib/locale-data.json` (the allowlist/registry) and the
// `_locales` tree + `manifest.json` — no TypeScript parsing.

import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const LOCALES_DIR = path.join(SRC, '_locales')
export const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/

// Bidi controls + default-ignorable characters not approved in any message.
// (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI, LRM/RLM, ALM, zero-width chars, BOM.)
export const DISALLOWED_CHAR_PATTERN =
  /[‪-‮⁦-⁩‎‏؜​-‍﻿­]/

function loadLocaleData() {
  const raw = readFileSync(path.join(SRC, 'lib', 'locale-data.json'), 'utf8')
  return JSON.parse(raw)
}

function fail(errors, message) {
  errors.push(message)
}

function checkTreeSafety(errors, allowedLocales) {
  let entries
  try {
    entries = readdirSync(LOCALES_DIR, { withFileTypes: true })
  } catch {
    fail(errors, `_locales directory missing: ${LOCALES_DIR}`)
    return
  }

  for (const entry of entries) {
    const entryPath = path.join(LOCALES_DIR, entry.name)
    const stat = lstatSync(entryPath)
    if (stat.isSymbolicLink()) {
      fail(errors, `_locales/${entry.name}: symlinks are not allowed`)
      continue
    }
    if (!stat.isDirectory()) {
      fail(errors, `_locales/${entry.name}: unexpected non-directory entry`)
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

  for (const locale of allowedLocales) {
    if (!entries.some((e) => e.name === locale)) {
      // Not every allowlisted locale needs to exist yet (catalogs land over
      // phases); only English is required at all times.
      if (locale === 'en') fail(errors, '_locales/en is required and missing')
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
