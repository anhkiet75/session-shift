#!/usr/bin/env node
// validate-localization-artifacts.mjs — Single command validating localization
// bytes across the three delivery stages: source, built `dist/`, and the
// packaged release ZIP. Each stage must carry exactly the source-controlled
// `_locales` catalogs, unresolved-token-free, with no symlinks/extra entries.
//
// Usage: node scripts/validate-localization-artifacts.mjs [source|dist|zip]
// Default: source. No production dependency; ZIP listing shells out to the
// system `unzip` (already required by scripts/package.sh).

import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main as validateSource, checkTreeSafety } from './validate-locales.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function loadLocaleData() {
  return JSON.parse(readFileSync(path.join(ROOT, 'src/lib/locale-data.json'), 'utf8'))
}

function presentSourceLocales(data) {
  return readdirSync(path.join(ROOT, 'src/_locales'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => data.supportedLocales.includes(name))
}

function validateDist() {
  const errors = []
  const data = loadLocaleData()
  const distLocalesDir = path.join(ROOT, 'dist/_locales')

  if (!existsSync(distLocalesDir)) {
    return { ok: false, errors: [`dist/_locales missing — run npm run build first`] }
  }

  checkTreeSafety(errors, data.supportedLocales, distLocalesDir)

  for (const locale of presentSourceLocales(data)) {
    const srcPath = path.join(ROOT, 'src/_locales', locale, 'messages.json')
    const distPath = path.join(distLocalesDir, locale, 'messages.json')
    if (!existsSync(distPath)) {
      errors.push(`dist/_locales/${locale}/messages.json missing`)
      continue
    }
    const srcContent = readFileSync(srcPath, 'utf8')
    const distContent = readFileSync(distPath, 'utf8')
    if (srcContent !== distContent) {
      errors.push(`dist/_locales/${locale}/messages.json does not byte-match src/_locales/${locale}/messages.json`)
    }
  }

  const distManifest = JSON.parse(readFileSync(path.join(ROOT, 'dist/manifest.json'), 'utf8'))
  if (distManifest.default_locale !== data.defaultLocale) {
    errors.push(`dist/manifest.json: default_locale must be "${data.defaultLocale}"`)
  }
  const englishCatalog = JSON.parse(readFileSync(path.join(distLocalesDir, data.defaultLocale, 'messages.json'), 'utf8'))
  const manifestRaw = readFileSync(path.join(ROOT, 'dist/manifest.json'), 'utf8')
  for (const m of manifestRaw.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
    if (!englishCatalog[m[1]]) errors.push(`dist/manifest.json: __MSG_${m[1]}__ has no matching dist English catalog entry`)
  }

  return { ok: errors.length === 0, errors }
}

function releaseZipPath() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'src/manifest.json'), 'utf8'))
  return path.join(ROOT, 'releases', `session_shift_v${manifest.version}.zip`)
}

function validateZip() {
  const errors = []
  const data = loadLocaleData()
  const zipPath = releaseZipPath()

  if (!existsSync(zipPath)) {
    return { ok: false, errors: [`release ZIP missing: ${zipPath} — run npm run package first`] }
  }

  let listing
  try {
    listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' })
  } catch (e) {
    return { ok: false, errors: [`unzip -l failed: ${e.message}`] }
  }

  const entries = listing
    .split('\n')
    .map((line) => line.trim().split(/\s+/).slice(3).join(' '))
    .filter(Boolean)
  const entrySet = new Set(entries)

  if (!entrySet.has('manifest.json')) errors.push('ZIP missing manifest.json')

  for (const locale of presentSourceLocales(data)) {
    const entry = `_locales/${locale}/messages.json`
    if (!entrySet.has(entry)) errors.push(`ZIP missing ${entry}`)
  }

  for (const entry of entries) {
    if (entry.includes('..')) errors.push(`ZIP entry escapes package root: ${entry}`)
  }

  // `unzip -l` can't show symlink/mode bits — extract to a scratch dir and
  // reuse the same tree-safety check (symlinks, extra files, allowlist) that
  // guards source and dist, so packaging can't silently smuggle either in.
  const extractDir = mkdtempSync(path.join(os.tmpdir(), 'sessionshift-zip-check-'))
  try {
    execFileSync('unzip', ['-q', zipPath, '_locales/*', '-d', extractDir])
    const extractedLocalesDir = path.join(extractDir, '_locales')
    if (existsSync(extractedLocalesDir)) {
      checkTreeSafety(errors, data.supportedLocales, extractedLocalesDir)
    } else {
      errors.push('ZIP has no _locales entries to extract for tree-safety check')
    }
  } catch (e) {
    errors.push(`ZIP extraction for tree-safety check failed: ${e.message}`)
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
  }

  return { ok: errors.length === 0, errors }
}

function runCli() {
  const stage = process.argv[2] || 'source'
  let result
  if (stage === 'source') result = validateSource()
  else if (stage === 'dist') result = validateDist()
  else if (stage === 'zip') result = validateZip()
  else {
    console.error(`Unknown stage "${stage}" — expected source|dist|zip`)
    process.exit(1)
  }

  if (!result.ok) {
    console.error(`[${stage}] Localization artifact validation failed (${result.errors.length} issue(s)):\n` + result.errors.map((e) => `  - ${e}`).join('\n'))
    process.exit(1)
  }
  console.log(`[${stage}] Localization artifact validation passed.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli()
