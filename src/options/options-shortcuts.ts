// options-shortcuts.ts — Settings → Keyboard shortcuts: a read-only view of the
// extension's current command bindings plus a jump to Chrome's shortcut editor.
//
// Chrome exposes no API to assign a key to a command (`chrome.commands.getAll`
// is read-only), so the only supported way to change one is
// `chrome://extensions/shortcuts`. An `<a href>` to a chrome:// URL is blocked
// from extension pages, hence `chrome.tabs.create`.

import type { Localizer } from '../lib/localization.js'
import type { MessageKey } from '../lib/localization-types.js'

const SHORTCUTS_PAGE_URL = 'chrome://extensions/shortcuts'

// Labels are in-app keys rather than `chrome.commands` descriptions: those are
// manifest-only and always follow the browser language, while this page
// honors the in-app language override.
const COMMAND_ROWS: ReadonlyArray<{ name: string; labelKey: MessageKey; fallback: string }> = [
  { name: '_execute_action', labelKey: 'shortcutOpenPopupLabel', fallback: 'Open SessionShift popup' },
  { name: 'session-next', labelKey: 'shortcutNextProfileLabel', fallback: 'Switch tab to next profile' },
  { name: 'session-prev', labelKey: 'shortcutPrevProfileLabel', fallback: 'Switch tab to previous profile' },
]

let activeLocalizer: Localizer | null = null
let listenersBound = false

async function readBindings(): Promise<Map<string, string>> {
  const commands = await chrome.commands.getAll()
  return new Map(commands.map(c => [c.name ?? '', c.shortcut ?? '']))
}

async function renderShortcutRows(): Promise<void> {
  const list = document.getElementById('shortcutList')
  if (!list || !activeLocalizer) return
  const localizer = activeLocalizer
  const bindings = await readBindings()

  list.replaceChildren(...COMMAND_ROWS.map(({ name, labelKey, fallback }) => {
    const row = document.createElement('li')
    row.className = 'opt-shortcut-row'

    const label = document.createElement('span')
    label.className = 'opt-setting-label'
    label.textContent = localizer.getMessage(labelKey) || fallback

    // Chrome returns a platform-formatted string (`⇧⌘S` on mac,
    // `Ctrl+Shift+S` elsewhere) — show it verbatim, never parse it.
    const shortcut = bindings.get(name) ?? ''
    const key = document.createElement('kbd')
    key.className = shortcut ? 'opt-shortcut-key' : 'opt-shortcut-key opt-shortcut-key-unset'
    key.dataset.command = name
    key.textContent = shortcut || localizer.getMessage('shortcutNotSet') || 'Not set'

    row.append(label, key)
    return row
  }))
}

/**
 * Render (or re-render after a language change) the Keyboard shortcuts rows.
 * Listeners are bound once; later calls only swap the localizer and redraw.
 */
export async function initShortcutsPanel(localizer: Localizer): Promise<void> {
  activeLocalizer = localizer

  if (!listenersBound) {
    listenersBound = true
    document.getElementById('openShortcutsBtn')?.addEventListener('click', () => {
      chrome.tabs.create({ url: SHORTCUTS_PAGE_URL })
    })
    // Returning from Chrome's editor refocuses this tab — pick up the new
    // binding without a reload.
    const refresh = (): void => { void renderShortcutRows() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh()
    })
  }

  await renderShortcutRows()
}
