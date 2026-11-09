#!/usr/bin/env node
// validate-localization-artifacts.ts — Single command validating localization
// bytes across the three delivery stages: source, built `dist/`, and the
// packaged release ZIP. Each stage must carry exactly the source-controlled
// `_locales` catalogs, unresolved-token-free, with no symlinks/extra entries.
//
// Usage: npx --no-install tsx scripts/validate-localization-artifacts.ts [source|dist|zip]
// Default: source. ZIP entries are parsed and CRC-checked in-process, so the
// validator works on Windows and Linux without an external unzip program.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main as validateSource, checkTreeSafety, loadLocaleData } from './validate-locales.ts'
import { readExtensionZip } from './extension-zip.js'
import { readJsonObject, readVersion } from './release-version.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function presentSourceLocales(data: ReturnType<typeof loadLocaleData>) {
  return readdirSync(path.join(ROOT, 'src/_locales'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => data.supportedLocales.includes(name))
}

function validateDist() {
  const errors: string[] = []
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

  const distManifest = readJsonObject(path.join(ROOT, 'dist/manifest.json'))
  if (distManifest.default_locale !== data.defaultLocale) {
    errors.push(`dist/manifest.json: default_locale must be "${data.defaultLocale}"`)
  }
  const englishCatalog = readJsonObject(path.join(distLocalesDir, data.defaultLocale, 'messages.json'))
  const manifestRaw = readFileSync(path.join(ROOT, 'dist/manifest.json'), 'utf8')
  for (const m of manifestRaw.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
    if (!englishCatalog[m[1]]) errors.push(`dist/manifest.json: __MSG_${m[1]}__ has no matching dist English catalog entry`)
  }

  return { ok: errors.length === 0, errors }
}

function releaseZipPath(version: string) {
  return path.join(ROOT, 'releases', `session_shift_v${version}.zip`)
}

function validateZip() {
  const errors: string[] = []
  const data = loadLocaleData()
  let version: string
  try {
    version = readVersion()
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  }
  const zipPath = releaseZipPath(version)

  if (!existsSync(zipPath)) {
    return { ok: false, errors: [`release ZIP missing: ${zipPath} — run npm run package first`] }
  }

  let archive
  try {
    archive = readExtensionZip(zipPath, version)
  } catch (e) {
    return { ok: false, errors: [`ZIP validation failed: ${e instanceof Error ? e.message : String(e)}`] }
  }

  if (archive.manifest.default_locale !== data.defaultLocale) {
    errors.push(`ZIP manifest.json: default_locale must be "${data.defaultLocale}"`)
  }

  const distRoot = path.join(ROOT, 'dist')
  const distEntries = readdirSync(distRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(distRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
  for (const entry of distEntries) {
    const packaged = archive.entries.get(entry)
    if (!packaged || !packaged.equals(readFileSync(path.join(distRoot, entry)))) {
      errors.push('ZIP entry does not byte-match dist: ' + entry)
    }
  }
  const expectedEntries = new Set(distEntries)
  for (const entry of archive.entries.keys()) {
    if (!expectedEntries.has(entry)) errors.push('ZIP contains unexpected entry: ' + entry)
  }

  const locales = presentSourceLocales(data)
  const expectedLocaleEntries = new Set([
    '_locales/translation-quality.json',
    ...locales.map((locale) => `_locales/${locale}/messages.json`),
  ])
  const packagedLocaleEntries = [...archive.entries.keys()].filter((entry) => entry.startsWith('_locales/'))
  for (const entry of packagedLocaleEntries) {
    if (!expectedLocaleEntries.has(entry)) errors.push(`ZIP contains unexpected locale entry: ${entry}`)
  }

  for (const locale of locales) {
    const entry = `_locales/${locale}/messages.json`
    const packaged = archive.entries.get(entry)
    if (!packaged) {
      errors.push(`ZIP missing ${entry}`)
      continue
    }
    const source = readFileSync(path.join(ROOT, 'src/_locales', locale, 'messages.json'))
    if (!source.equals(packaged)) errors.push(`ZIP ${entry} does not byte-match its source catalog`)
  }

  const qualityEntry = archive.entries.get('_locales/translation-quality.json')
  if (!qualityEntry) {
    errors.push('ZIP missing _locales/translation-quality.json')
  } else {
    const sourceQuality = readFileSync(path.join(ROOT, 'src/_locales/translation-quality.json'))
    if (!sourceQuality.equals(qualityEntry)) {
      errors.push('ZIP _locales/translation-quality.json does not byte-match its source file')
    }
  }

  const englishEntry = archive.entries.get(`_locales/${data.defaultLocale}/messages.json`)
  if (englishEntry) {
    const englishCatalog = readJsonObject(path.join(ROOT, 'src/_locales', data.defaultLocale, 'messages.json'))
    const manifestRaw = JSON.stringify(archive.manifest)
    for (const m of manifestRaw.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
      if (!englishCatalog[m[1]]) errors.push(`ZIP manifest.json: __MSG_${m[1]}__ has no matching English catalog entry`)
    }
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    console.error(`[localization-artifacts] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
