// options.ts — Options page (ESM module)

import type { ExtSettings } from '../lib/types.js'

const SETTINGS_KEY = 'ext_settings'

async function loadSettings(): Promise<ExtSettings> {
  const result = await chrome.storage.local.get([SETTINGS_KEY])
  return (result[SETTINGS_KEY] as ExtSettings) || { theme: 'system' }
}

async function saveSettings(settings: ExtSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
}

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
  const settings = await loadSettings()
  const currentTheme = settings.theme || 'system'
  applyTheme(currentTheme)
  updateThemePicker(currentTheme)
  document.querySelectorAll('.opt-theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newTheme = (btn as HTMLElement).dataset.themeVal || 'system'
      applyTheme(newTheme)
      updateThemePicker(newTheme)
      const s = await loadSettings()
      await saveSettings({ ...s, theme: newTheme as ExtSettings['theme'] })
    })
  })

  // About tab
  const { version } = chrome.runtime.getManifest()
  document.getElementById('aboutVersion')!.textContent = `v${version}`
})
