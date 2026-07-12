// localization.ts — Runtime locale adapter: System (native chrome.i18n) or a
// packaged manual catalog, both falling back to English. No production
// dependency; every packaged fetch is local (`chrome.runtime.getURL`) and the
// locale is allowlist-checked before any path is constructed.

import {
  DEFAULT_LOCALE,
  LOCALE_METADATA,
  isSupportedLocale,
  type SupportedLocale,
  type RuntimeLocalePreference,
  type TextDirection,
  type ChromeMessageCatalog,
  type ChromeMessageEntry,
} from './localization-types.js'
import { getExtSettings } from './settings-store.js'

export interface Localizer {
  preference: RuntimeLocalePreference
  languageTag: string
  direction: TextDirection
  getMessage(key: string, substitutions?: readonly string[]): string
}

/** Reads `ext_settings.language`; absent/invalid values resolve to `'system'`. */
export async function getLanguagePreference(): Promise<RuntimeLocalePreference> {
  const settings = await getExtSettings()
  const value = settings.language
  if (value === 'system' || value === undefined) return 'system'
  return isSupportedLocale(value) ? value : 'system'
}

// Cache only the active manual locale + English per context (module scope =
// one execution context: one popup/options page instance or one service-worker
// lifetime). A cold worker starts with an empty cache and re-fetches lazily.
const catalogCache = new Map<SupportedLocale, Promise<ChromeMessageCatalog | null>>()

function pruneCache(keep: readonly SupportedLocale[]): void {
  for (const locale of catalogCache.keys()) {
    if (!keep.includes(locale)) catalogCache.delete(locale)
  }
}

function isValidCatalogShape(value: unknown): value is ChromeMessageCatalog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every(
    (entry) => typeof entry === 'object' && entry !== null && typeof (entry as ChromeMessageEntry).message === 'string'
  )
}

/**
 * Fetches `_locales/<locale>/messages.json` from the package. `locale` MUST be
 * checked against `SUPPORTED_LOCALES` before this is called — never construct
 * the request path from an unvalidated string (message sender, storage, URL).
 */
export function loadCatalog(locale: SupportedLocale): Promise<ChromeMessageCatalog | null> {
  // Runtime allowlist check — never trust the caller's type alone. `locale`
  // may ultimately originate from storage or a message sender, so re-validate
  // here before any path is constructed, even though the parameter is typed.
  if (!isSupportedLocale(locale)) return Promise.resolve(null)

  const cached = catalogCache.get(locale)
  if (cached) return cached

  const promise = (async () => {
    try {
      const response = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`))
      if (!response.ok) return null
      const parsed = await response.json()
      return isValidCatalogShape(parsed) ? parsed : null
    } catch {
      return null
    }
  })()

  catalogCache.set(locale, promise)
  // A transient failure (momentary fetch error, unreadable response) must not
  // wedge this locale as permanently blank for the rest of the context's
  // lifetime — only a successful parse is worth caching. Uncache on null so
  // the next call retries instead of replaying the stale failure.
  promise.then((result) => {
    if (result === null && catalogCache.get(locale) === promise) catalogCache.delete(locale)
  })
  return promise
}

function substitute(message: string, entry: ChromeMessageEntry, substitutions?: readonly string[]): string {
  if (!substitutions || substitutions.length === 0) return message
  const order = Object.keys(entry.placeholders ?? {})
  return message.replace(/\$([A-Za-z0-9_]+)\$/g, (full, name: string) => {
    const position = order.indexOf(name)
    return position === -1 ? full : String(substitutions[position] ?? '')
  })
}

function systemDirection(): TextDirection {
  // Chrome's own bidi indicator — correct only for the native UI locale.
  return chrome.i18n.getMessage('@@bidi_dir') === 'rtl' ? 'rtl' : 'ltr'
}

/**
 * Builds a resolved localizer for `preference`. `'system'` uses native
 * `chrome.i18n.getMessage` (cannot target a manual locale); any other value
 * loads the packaged catalog for that exact locale, falling back to packaged
 * English only — never a generic parent-language fallback.
 */
export async function createLocalizer(preference: RuntimeLocalePreference): Promise<Localizer> {
  if (preference === 'system') {
    pruneCache([DEFAULT_LOCALE])
    return {
      preference,
      languageTag: chrome.i18n.getUILanguage(),
      direction: systemDirection(),
      getMessage: (key, substitutions) => chrome.i18n.getMessage(key, substitutions as string[] | undefined),
    }
  }

  pruneCache([preference, DEFAULT_LOCALE])
  const [manualCatalog, englishCatalog] = await Promise.all([
    loadCatalog(preference),
    preference === DEFAULT_LOCALE ? Promise.resolve(null) : loadCatalog(DEFAULT_LOCALE),
  ])
  const meta = LOCALE_METADATA[preference]

  return {
    preference,
    languageTag: meta.languageTag,
    direction: meta.direction,
    getMessage(key, substitutions) {
      const entry = manualCatalog?.[key] ?? englishCatalog?.[key]
      if (!entry) return ''
      return substitute(entry.message, entry, substitutions)
    },
  }
}

export function getResolvedLanguageTag(localizer: Localizer): string {
  return localizer.languageTag
}

export function getTextDirection(localizer: Localizer): TextDirection {
  return localizer.direction
}

/** Idempotent: only touches `<html>` attributes when the resolved value changed. */
export function applyDocumentLocale(document: Document, localizer: Localizer): void {
  const root = document.documentElement
  if (root.lang !== localizer.languageTag) root.lang = localizer.languageTag
  if (root.dir !== localizer.direction) root.dir = localizer.direction
}

/**
 * Guards against a stale in-flight locale resolution overwriting a newer
 * selection (e.g. `de` requested, then `ar` requested before `de`'s catalog
 * fetch resolves). Callers request a generation before starting async work
 * and check `isLatest` before committing its result.
 */
export function createGenerationGuard() {
  let current = 0
  return {
    next: (): number => ++current,
    isLatest: (generation: number): boolean => generation === current,
  }
}
