// options.ts — Options page (ESM module)

import type { ExtSettings } from '../lib/types.js'
import { getExtSettings, mutateExtSettingsField } from '../lib/settings-store.js'

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

document.addEventListener('DOMContentLoaded', async () => {
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

  // About tab
  const { version } = chrome.runtime.getManifest()
  document.getElementById('aboutVersion')!.textContent = `v${version}`
})
