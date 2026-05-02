// options.js — Auto-assign rules management (ESM module)

import { normalizePattern } from '../lib/rule-matcher.js'

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

document.addEventListener('DOMContentLoaded', async () => {
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
})
