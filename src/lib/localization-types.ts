// localization-types.ts — Locale/key/catalog/placeholder contracts.
// Single source of truth for the 55 Chrome extension locale codes, their
// BCP 47 document tags, text direction, and English-fallback behavior.

/** Chrome `_locales/<code>` directory codes — exact documented CWS/i18n set. */
export const SUPPORTED_LOCALES = [
  'am', 'ar', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'en_AU', 'en_GB',
  'en_US', 'es', 'es_419', 'et', 'fa', 'fi', 'fil', 'fr', 'gu', 'he', 'hi',
  'hr', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lt', 'lv', 'ml', 'mr', 'ms', 'nl',
  'no', 'pl', 'pt_BR', 'pt_PT', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'sw', 'ta',
  'te', 'th', 'tr', 'uk', 'vi', 'zh_CN', 'zh_TW',
] as const;

export type SupportedLocale = typeof SUPPORTED_LOCALES[number];

/** Locales rendered right-to-left. Every other supported locale is LTR. */
export const RTL_LOCALES: readonly SupportedLocale[] = ['ar', 'fa', 'he'];

export type TextDirection = 'ltr' | 'rtl';

/** English is the canonical catalog and the runtime fallback for missing keys. */
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/** Stored preference: `'system'` delegates to Chrome's UI locale; otherwise pinned. */
export type RuntimeLocalePreference = 'system' | SupportedLocale;

export interface LocaleMetadata {
  /** Chrome `_locales` directory code, e.g. `pt_BR`. */
  code: SupportedLocale;
  /** BCP 47 document tag for `<html lang>`, e.g. `pt-BR`. */
  languageTag: string;
  direction: TextDirection;
}

function toLanguageTag(code: SupportedLocale): string {
  return code.replace('_', '-');
}

export const LOCALE_METADATA: Record<SupportedLocale, LocaleMetadata> = Object.fromEntries(
  SUPPORTED_LOCALES.map((code) => [
    code,
    {
      code,
      languageTag: toLanguageTag(code),
      direction: (RTL_LOCALES as readonly string[]).includes(code) ? 'rtl' : 'ltr',
    } satisfies LocaleMetadata,
  ]),
) as Record<SupportedLocale, LocaleMetadata>;

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function directionFor(locale: SupportedLocale): TextDirection {
  return LOCALE_METADATA[locale].direction;
}

/** A single Chrome i18n message entry: `{ message, description?, placeholders? }`. */
export interface ChromeMessagePlaceholder {
  content: string;
  example?: string;
}

export interface ChromeMessageEntry {
  message: string;
  description?: string;
  placeholders?: Record<string, ChromeMessagePlaceholder>;
}

/** One `_locales/<code>/messages.json` file: message key -> entry. */
export type ChromeMessageCatalog = Record<string, ChromeMessageEntry>;

/**
 * Every key ever referenced from DOM markers, manifest tokens, or message
 * registries. Kept as a literal union so the validator and tests can check
 * exhaustiveness against the English catalog.
 */
export type MessageKey =
  | 'extensionName'
  | 'extensionDescription'
  | 'commandExecuteActionDescription'
  | 'commandSessionNextDescription'
  | 'commandSessionPrevDescription'
  | 'popupBrandSub'
  | 'themeToggleLabel'
  | 'themeNameLight'
  | 'themeNameDark'
  | 'themeNameSystem'
  | 'openOptionsLabel'
  | 'heroActiveLabel'
  | 'heroDefaultName'
  | 'heroNoSessionMeta'
  | 'searchPlaceholder'
  | 'searchAriaLabel'
  | 'createPlaceholder'
  | 'createButton'
  | 'listHeadProfiles'
  | 'resetToDefault'
  | 'switchToDefaultConfirm'
  | 'cancelButton'
  | 'resetButton'
  | 'cannotIsolatePage'
  | 'generatedSessionName'
  | 'duplicatedSessionName'
  | 'emptyNoProfilesTitle'
  | 'emptyNoProfilesSub'
  | 'emptyNoMatchesTitle'
  | 'emptyNoMatchesSub'
  | 'duplicateProfileTitle'
  | 'duplicateProfileAriaLabel'
  | 'renameTitle'
  | 'renameAriaLabel'
  | 'deleteTitle'
  | 'deleteAriaLabel'
  | 'cancelDeleteTitle'
  | 'confirmDeleteTitle'
  | 'activeStatusPill'
  | 'heroLiveLabel'
  | 'openInNewTab'
  | 'changeColorTitle'
  | 'changeColorAriaLabel'
  | 'pickColorAriaLabel'
  | 'sessionColorLabel'
  | 'hueSwatchTitle'
  | 'customHueTitle'
  | 'customHueAriaLabel'
  | 'customLabel'
  | 'customHueValueAriaLabel'
  | 'optionsSubtitle'
  | 'extensionVersionAriaLabel'
  | 'tabSettings'
  | 'tabAbout'
  | 'appearanceSectionTitle'
  | 'themeSettingLabel'
  | 'themeSettingDesc'
  | 'themeGroupAriaLabel'
  | 'autoInheritLabel'
  | 'autoInheritDesc'
  | 'aboutTagline'
  | 'supportSectionTitle'
  | 'supportDesc'
  | 'supportCta'
  | 'linksSectionTitle'
  | 'githubLink'
  | 'chromeWebStoreLink'
  | 'contextMenuParentTitle'
  | 'languageSettingLabel'
  | 'languageSettingDesc'
  | 'languageOptionSystem';

/** Keys only ever read from `manifest.json` via `__MSG_key__` tokens. */
export const MANIFEST_ONLY_KEYS: readonly MessageKey[] = [
  'extensionName',
  'extensionDescription',
  'commandExecuteActionDescription',
  'commandSessionNextDescription',
  'commandSessionPrevDescription',
];

/** Named substitution placeholders declared per key (superset across catalogs). */
export const MESSAGE_PLACEHOLDERS: Partial<Record<MessageKey, readonly string[]>> = {
  themeToggleLabel: ['theme'],
  generatedSessionName: ['index'],
  duplicatedSessionName: ['name'],
  duplicateProfileAriaLabel: ['name'],
  renameAriaLabel: ['name'],
  deleteAriaLabel: ['name'],
  hueSwatchTitle: ['hue'],
};
