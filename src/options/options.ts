// options.ts — Options page (ESM module)

import type { ExtSettings } from '../lib/types.js'
import { getExtSettings, mutateExtSettingsField } from '../lib/settings-store.js'
import { reconcileTabGroupsSetting } from '../lib/tab-groups-permission.js'
import {
  getLanguagePreference,
  createLocalizer,
  applyDocumentLocale,
  localizeDocument,
  getLocaleDisplayName,
  createGenerationGuard,
} from '../lib/localization.js'
import type { Localizer } from '../lib/localization.js'
import { SUPPORTED_LOCALES } from '../lib/localization-types.js'
import type { RuntimeLocalePreference } from '../lib/localization-types.js'

function applyTheme(theme: string): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
}

function updateThemePicker(theme: string): void {
  document.querySelectorAll('.opt-theme-btn').forEach(btn => {
    btn.setAttribute('aria-pressed', String((btn as HTMLElement).dataset.themeVal === theme))
  })
}

function populateLanguageSelect(select: HTMLSelectElement, localizer: Localizer, current: RuntimeLocalePreference): void {
  select.replaceChildren()
  const systemOption = document.createElement('option')
  systemOption.value = 'system'
  systemOption.textContent = localizer.getMessage('languageOptionSystem') || 'System (match browser)'
  select.appendChild(systemOption)

  for (const locale of SUPPORTED_LOCALES) {
    const option = document.createElement('option')
    option.value = locale
    option.textContent = `${getLocaleDisplayName(locale)} (${locale})`
    select.appendChild(option)
  }
  select.value = current
}

/** Never throws — the last-resort fallback if even `createLocalizer('system')` fails. */
function inertFallbackLocalizer(): Localizer {
  return { preference: 'system', languageTag: 'en', direction: 'ltr', getMessage: () => '' }
}

async function resolveLocalizer(): Promise<Localizer> {
  try {
    return await createLocalizer(await getLanguagePreference())
  } catch {
    // Recoverable failure: fall back to native System resolution.
  }
  try {
    return await createLocalizer('system')
  } catch {
    return inertFallbackLocalizer()
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const pageRoot = document.querySelector('.opt-page') as HTMLElement | null
  const reveal = (): void => {
    pageRoot?.removeAttribute('inert')
    pageRoot?.removeAttribute('aria-busy')
  }

  try {
    let localizer = await resolveLocalizer()
    applyDocumentLocale(document, localizer)
    localizeDocument(document, localizer)

    // Tab switching
    document.querySelectorAll('.opt-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.opt-tab').forEach(t => {
          t.classList.remove('active')
          t.setAttribute('aria-selected', 'false')
        })
        document.querySelectorAll('.opt-panel').forEach(p => p.classList.add('hidden'))
        tab.classList.add('active')
        tab.setAttribute('aria-selected', 'true')
        document.getElementById(`panel-${(tab as HTMLElement).dataset.tab}`)!.classList.remove('hidden')
      })
    })

    // Settings tab
    const settings = await getExtSettings()
    const currentTheme = settings.theme || 'system'
    applyTheme(currentTheme)
    updateThemePicker(currentTheme)
    document.querySelectorAll('.opt-theme-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newTheme = (btn as HTMLElement).dataset.themeVal || 'system'
        applyTheme(newTheme)
        updateThemePicker(newTheme)
        await mutateExtSettingsField('theme', newTheme as ExtSettings['theme'])
      })
    })

    const autoInheritToggle = document.getElementById('autoInheritToggle') as HTMLInputElement
    autoInheritToggle.checked = settings.autoInheritProfileForLinkedTabs !== false
    autoInheritToggle.addEventListener('change', async () => {
      await mutateExtSettingsField('autoInheritProfileForLinkedTabs', autoInheritToggle.checked)
    })

    // Phase 4: the setting and the `tabGroups` grant are independent facts —
    // render their actual combination on load rather than trusting the
    // stored setting alone (the grant may have been revoked out-of-band
    // since this was last opened).
    const groupTabsToggle = document.getElementById('groupTabsByProfileToggle') as HTMLInputElement
    const groupTabsDeniedNotice = document.getElementById('groupTabsDeniedNotice') as HTMLElement
    if (settings.groupTabsByProfile === true && !(await reconcileTabGroupsSetting())) {
      groupTabsToggle.checked = true
    } else {
      groupTabsToggle.checked = false
    }
    groupTabsToggle.addEventListener('change', async () => {
      groupTabsDeniedNotice.classList.add('hidden')

      if (!groupTabsToggle.checked) {
        // Off: no permission work needed to turn off. The background's
        // ext_settings storage listener does the actual ungroup + registry
        // clear once this write lands (tab-group-sync.ts's on/off transition).
        await mutateExtSettingsField('groupTabsByProfile', false)
        return
      }

      // On: chrome.permissions.request() must be the FIRST await in this
      // handler — any prior await can consume the user gesture and make
      // Chrome reject the request outright.
      const granted = await chrome.permissions.request({ permissions: ['tabGroups'] })
      if (!granted) {
        groupTabsToggle.checked = false
        groupTabsDeniedNotice.classList.remove('hidden')
        return // nothing persisted — next Options load renders off, no memory of the refusal
      }
      await mutateExtSettingsField('groupTabsByProfile', true)
    })

    // Language picker — writes through the serialized mutator, then re-resolves
    // and reapplies localization in place (no tab/panel/theme/focus reset).
    const languageSelect = document.getElementById('languageSelect') as HTMLSelectElement
    populateLanguageSelect(languageSelect, localizer, localizer.preference)

    const generationGuard = createGenerationGuard()
    languageSelect.addEventListener('change', async () => {
      const chosen = languageSelect.value as RuntimeLocalePreference
      const generation = generationGuard.next()
      await mutateExtSettingsField('language', chosen === 'system' ? undefined : chosen)
      const nextLocalizer = await createLocalizer(chosen)
      // A faster later selection may have already resolved and committed while
      // this one was in flight — never let a stale result overwrite it.
      if (!generationGuard.isLatest(generation)) return
      localizer = nextLocalizer
      applyDocumentLocale(document, localizer)
      localizeDocument(document, localizer)
      populateLanguageSelect(languageSelect, localizer, chosen)
    })

    // About tab
    const { version } = chrome.runtime.getManifest()
    document.getElementById('aboutVersion')!.textContent = `v${version}`
  } finally {
    // Always reveal — a thrown error above must not leave Options permanently
    // inert/blank.
    reveal()
  }
})
