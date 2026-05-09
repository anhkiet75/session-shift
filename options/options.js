// options.js — Options page (ESM module)

import { normalizePattern } from '../lib/rule-matcher.js'
import { exportSessions, importSessions } from '../lib/session-store.js'

// ---------------------------------------------------------------------------
// Storage helpers (direct storage access — options page has storage permission)
// ---------------------------------------------------------------------------

async function loadRules() {
  const result = await chrome.storage.local.get(['assign_rules'])
  return result['assign_rules'] || []
}

async function saveRules(rules) {
  await chrome.storage.local.set({ assign_rules: rules })
}

async function loadSessions() {
  const all = await chrome.storage.local.get(null)
  const sessions = []
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('list_') || !Array.isArray(value)) continue
    const origin = key.slice('list_'.length)
    let hostname
    try { hostname = new URL(origin).hostname } catch { hostname = origin }
    for (const s of value) {
      if (s && typeof s.id === 'string') {
        sessions.push({ id: s.id, name: s.name || s.id, hue: s.hue, origin, hostname })
      }
    }
  }
  return sessions.sort((a, b) =>
    a.hostname.localeCompare(b.hostname) || a.name.localeCompare(b.name)
  )
}

function generateId() {
  return 'rule_' + Math.random().toString(36).slice(2, 9)
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderRules(rules, sessions) {
  const list = document.getElementById('rulesList')
  const empty = document.getElementById('emptyState')
  const count = document.getElementById('ruleCount')

  count.textContent = rules.length
  list.innerHTML = ''

  if (rules.length === 0) {
    empty.classList.remove('hidden')
    return
  }
  empty.classList.add('hidden')

  for (const rule of rules) {
    const session = sessions.find(s => s.id === rule.sessionId)
    const sessionLabel = session
      ? `${session.name} — ${session.hostname}`
      : `<span class="opt-deleted">Session deleted</span>`

    const card = document.createElement('div')
    card.className = 'opt-rule-card'
    card.dataset.id = rule.id
    card.innerHTML = `
      <label class="opt-toggle" title="${rule.enabled ? 'Disable rule' : 'Enable rule'}">
        <input type="checkbox" class="opt-toggle-input" ${rule.enabled ? 'checked' : ''}>
        <span class="opt-toggle-track"></span>
      </label>
      <div class="opt-rule-info">
        <span class="opt-rule-pattern">${escapeHtml(rule.pattern)}</span>
        <span class="opt-rule-session">${sessionLabel}</span>
      </div>
      <button class="opt-btn-delete" title="Delete rule" aria-label="Delete rule">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    `

    card.querySelector('.opt-toggle-input').addEventListener('change', async (e) => {
      const updated = rules.map(r => r.id === rule.id ? { ...r, enabled: e.target.checked } : r)
      await saveRules(updated)
      renderRules(updated, sessions)
    })

    card.querySelector('.opt-btn-delete').addEventListener('click', async () => {
      const updated = rules.filter(r => r.id !== rule.id)
      await saveRules(updated)
      renderRules(updated, sessions)
    })

    list.appendChild(card)
  }
}

function populateSessionSelect(sessions) {
  const select = document.getElementById('sessionSelect')
  // Keep placeholder option
  select.innerHTML = '<option value="">— select a session —</option>'

  if (sessions.length === 0) {
    const opt = document.createElement('option')
    opt.disabled = true
    opt.textContent = 'No sessions yet — create one in the popup first'
    select.appendChild(opt)
    return
  }

  // Group by origin
  const byOrigin = {}
  for (const s of sessions) {
    if (!byOrigin[s.hostname]) byOrigin[s.hostname] = []
    byOrigin[s.hostname].push(s)
  }

  for (const [hostname, group] of Object.entries(byOrigin)) {
    const optgroup = document.createElement('optgroup')
    optgroup.label = hostname
    for (const s of group) {
      const opt = document.createElement('option')
      // Encode both sessionId and origin in value, split on first '|'
      opt.value = `${s.id}|${s.origin}`
      opt.textContent = s.name
      optgroup.appendChild(opt)
    }
    select.appendChild(optgroup)
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'ext_settings'

async function loadSettings() {
  const result = await chrome.storage.local.get([SETTINGS_KEY])
  return result[SETTINGS_KEY] || { notifyOnAutoAssign: false, theme: 'system' }
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
}

function applyTheme(theme) {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
}

function updateThemePicker(theme) {
  document.querySelectorAll('.opt-theme-btn').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeVal === theme))
  })
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

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
      document.getElementById(`panel-${tab.dataset.tab}`).classList.remove('hidden')
    })
  })

  // Rules tab init
  const patternInput  = document.getElementById('patternInput')
  const patternHint   = document.getElementById('patternHint')
  const sessionSelect = document.getElementById('sessionSelect')
  const btnAddRule    = document.getElementById('btnAddRule')

  const [rules, sessions] = await Promise.all([loadRules(), loadSessions()])
  populateSessionSelect(sessions)
  renderRules(rules, sessions)

  function updateAddButton() {
    const pattern = normalizePattern(patternInput.value)
    btnAddRule.disabled = !pattern || !sessionSelect.value
  }

  patternInput.addEventListener('input', () => {
    const normalized = normalizePattern(patternInput.value)
    patternHint.textContent = normalized ? `Will match: ${normalized}` : ''
    updateAddButton()
  })

  sessionSelect.addEventListener('change', updateAddButton)

  btnAddRule.addEventListener('click', async () => {
    const pattern = normalizePattern(patternInput.value)
    const [sessionId, origin] = sessionSelect.value.split('|')
    if (!pattern || !sessionId || !origin) return

    const current = await loadRules()
    current.push({ id: generateId(), pattern, sessionId, origin, enabled: true })
    await saveRules(current)
    renderRules(current, sessions)

    patternInput.value = ''
    patternHint.textContent = ''
    sessionSelect.value = ''
    btnAddRule.disabled = true
  })

  patternInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !btnAddRule.disabled) btnAddRule.click()
  })

  // Backup tab — Export
  document.getElementById('btnExport').addEventListener('click', async () => {
    const allSessions = await exportSessions()
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      generator: `SessionShift/${chrome.runtime.getManifest().version}`,
      sessions: allSessions,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sessionshift-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    document.getElementById('exportMeta').textContent = `${allSessions.length} session${allSessions.length !== 1 ? 's' : ''} exported`
  })

  // Backup tab — Import
  document.getElementById('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]
    if (!file) return
    const status = document.getElementById('importStatus')
    status.className = 'opt-import-status'
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      if (!data.sessions || !Array.isArray(data.sessions)) throw new Error('Invalid backup file')
      const { imported } = await importSessions(data.sessions)
      status.textContent = `✓ Imported ${imported} session${imported !== 1 ? 's' : ''}`
      status.classList.add('opt-status-ok')
    } catch (err) {
      status.textContent = `✗ Import failed: ${err.message}`
      status.classList.add('opt-status-err')
    }
    status.classList.remove('hidden')
    e.target.value = ''
  })

  // Settings tab
  const settings = await loadSettings()

  // Theme picker
  const currentTheme = settings.theme || 'system'
  applyTheme(currentTheme)
  updateThemePicker(currentTheme)
  document.querySelectorAll('.opt-theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newTheme = btn.dataset.themeVal
      applyTheme(newTheme)
      updateThemePicker(newTheme)
      const s = await loadSettings()
      await saveSettings({ ...s, theme: newTheme })
    })
  })

  const toggleNotify = document.getElementById('toggleNotify')
  toggleNotify.checked = settings.notifyOnAutoAssign
  toggleNotify.addEventListener('change', async () => {
    const current = await loadSettings()
    await saveSettings({ ...current, notifyOnAutoAssign: toggleNotify.checked })
  })

  // About tab
  const { version } = chrome.runtime.getManifest()
  document.getElementById('aboutVersion').textContent = `v${version}`
})
