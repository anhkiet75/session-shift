// popup.js — Stacks design (ESM module)

import { getAllSessions } from '../lib/session-store.js';

const HUE_PALETTE = [212, 158, 24, 278, 196, 340, 45];

const HUE_FROM_COLOR = {
  '#7c3aed': 262,
  '#2563eb': 219,
  '#059669': 161,
  '#d97706': 36,
  '#dc2626': 0,
  '#db2777': 333,
  '#0891b2': 191,
};

function getSessionHue(session, index) {
  if (session.hue !== undefined) return session.hue;
  if (session.color && HUE_FROM_COLOR[session.color] !== undefined) return HUE_FROM_COLOR[session.color];
  return HUE_PALETTE[index % HUE_PALETTE.length];
}

document.addEventListener('DOMContentLoaded', async () => {
  const { version } = chrome.runtime.getManifest();
  document.getElementById('versionChip').textContent = `v${version}`;
  const currentTab = await getCurrentTab();

  if (!currentTab.url || currentTab.url.startsWith('chrome://') || currentTab.url.startsWith('chrome-extension://') || currentTab.url.startsWith('about:')) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:24px 16px;text-align:center;font-size:12px;font-weight:500;color:var(--text-muted);';
    msg.textContent = 'Cannot isolate this page.';
    document.querySelector('.v2-popup').appendChild(msg);
    return;
  }

  const origin = new URL(currentTab.url).origin;

  const inputEl        = document.getElementById('newSessionName');
  const createRow      = document.getElementById('createRow');
  const btnNewSession  = document.getElementById('btnNewSession');
  const savedList      = document.getElementById('savedSessionsList');
  const resetArea      = document.getElementById('resetArea');
  const btnDefault     = document.getElementById('btnDefault');
  const btnOptions     = document.getElementById('btnOptions');

  btnOptions?.addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Current session
  const activeSessionResponse = await chrome.runtime.sendMessage({
    action: 'getSession',
    payload: { tabId: currentTab.id }
  });
  const currentSessionId = activeSessionResponse?.sessionId || 'default';

  const saved = await getSavedSessions(origin);
  const currentSessionObj = saved.find(s => s.id === currentSessionId);
  const currentHue = currentSessionObj ? getSessionHue(currentSessionObj, saved.indexOf(currentSessionObj)) : null;

  updateHero(currentSessionId, currentSessionObj, currentHue);

  // Reset button — confirm pattern
  btnDefault.disabled = currentSessionId === 'default';

  function showResetButton() {
    resetArea.innerHTML = `
      <button id="btnDefault" class="v2-reset"${currentSessionId === 'default' ? ' disabled' : ''}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8a5 5 0 1 0 1.5-3.5M3 3v3h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Reset to default
      </button>
    `;
    document.getElementById('btnDefault').addEventListener('click', showConfirm);
  }

  function showConfirm() {
    resetArea.innerHTML = `
      <div class="v2-confirm">
        <span>Switch to default?</span>
        <div class="v2-confirm-actions">
          <button class="v2-btn-ghost" id="btnCancelReset">Cancel</button>
          <button class="v2-btn-danger" id="btnConfirmReset">Reset</button>
        </div>
      </div>
    `;
    document.getElementById('btnCancelReset').addEventListener('click', showResetButton);
    document.getElementById('btnConfirmReset').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId: currentTab.id, sessionId: 'default' } });
      chrome.tabs.reload(currentTab.id);
      window.close();
    });
  }

  btnDefault.addEventListener('click', showConfirm);

  // Input focus styling
  inputEl.addEventListener('focus', () => createRow.classList.add('focused'));
  inputEl.addEventListener('blur',  () => createRow.classList.remove('focused'));

  // Create session
  btnNewSession.addEventListener('click', async () => {
    const newId    = 'session_' + Math.random().toString(36).substring(2, 9);
    const userInput = inputEl.value.trim();
    const name     = userInput || `Session ${saved.length + 1}`;
    const hue      = HUE_PALETTE[saved.length % HUE_PALETTE.length];
    const newSession = { id: newId, name, hue };

    const sessions = await getSavedSessions(origin);
    sessions.push(newSession);
    await setSavedSessions(origin, sessions);

    await chrome.runtime.sendMessage({ action: 'createSessionTab', payload: { url: currentTab.url, sessionId: newId } });
    window.close();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnNewSession.click();
  });

  // Render sessions
  renderSessionList(savedList, saved, currentSessionId, origin, currentTab.id);

  // ── View mode toggle (This site ↔ All sessions) ─────
  let viewMode = 'origin';
  let cachedGlobal = null;
  let searchQuery = '';
  let searchTimer = null;

  const tabOrigin   = document.getElementById('tabOrigin');
  const tabGlobal   = document.getElementById('tabGlobal');
  const searchWrap  = document.getElementById('searchWrap');
  const searchInput = document.getElementById('searchInput');

  async function setViewMode(mode) {
    if (mode === viewMode) return;
    viewMode = mode;
    tabOrigin.classList.toggle('active', mode === 'origin');
    tabGlobal.classList.toggle('active', mode === 'global');
    createRow.hidden = mode === 'global';
    searchWrap.hidden = mode !== 'global';

    if (mode === 'global') {
      if (!cachedGlobal) cachedGlobal = await getAllSessions();
      renderGlobalList(savedList, cachedGlobal, currentSessionId, origin, currentTab.id, searchQuery);
    } else {
      const fresh = await getSavedSessions(origin);
      renderSessionList(savedList, fresh, currentSessionId, origin, currentTab.id);
    }
  }

  tabOrigin.addEventListener('click', () => setViewMode('origin'));
  tabGlobal.addEventListener('click', () => setViewMode('global'));

  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (viewMode === 'global' && cachedGlobal) {
        renderGlobalList(savedList, cachedGlobal, currentSessionId, origin, currentTab.id, searchQuery);
      }
    }, 80);
  });
});

function renderGlobalList(container, sessions, currentSessionId, currentOrigin, tabId, query) {
  const header = container.querySelector('.v2-list-head');
  while (container.lastChild && container.lastChild !== header) {
    container.removeChild(container.lastChild);
  }

  const q = (query || '').toLowerCase().trim();
  const filtered = q
    ? sessions.filter(s =>
        (s.name || '').toLowerCase().includes(q) ||
        (s.origin || '').toLowerCase().includes(q))
    : sessions;

  const countEl = document.getElementById('sessionCount');
  if (countEl) countEl.textContent = filtered.length;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'v2-empty';
    empty.innerHTML = sessions.length === 0
      ? `<div class="v2-empty-title">No sessions anywhere yet</div>
         <div class="v2-empty-sub">Switch back to "This site" to create one.</div>`
      : `<div class="v2-empty-title">No matches</div>
         <div class="v2-empty-sub">Try a different search.</div>`;
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'v2-list';
  container.appendChild(list);

  filtered.forEach((session, i) => {
    const isActive = session.id === currentSessionId;
    const hue = getSessionHue(session, i);
    const sameOrigin = session.origin === currentOrigin;

    const card = document.createElement('div');
    card.className = 'v2-card' + (isActive ? ' active' : '');
    card.style.setProperty('--hue', hue);
    card.style.setProperty('--i', i);

    const bar = document.createElement('div');
    bar.className = 'v2-card-bar';

    const mark = document.createElement('div');
    mark.className = 'v2-card-mark';
    const dot = document.createElement('span');
    dot.className = 'v2-card-mark-dot';
    mark.appendChild(dot);

    const body = document.createElement('div');
    body.className = 'v2-card-body';

    const nameEl = document.createElement('div');
    nameEl.className = 'v2-card-name';
    nameEl.textContent = session.name || session.id;
    nameEl.title = session.name || session.id;
    body.appendChild(nameEl);

    const meta = document.createElement('div');
    meta.className = 'v2-card-meta';
    let host = session.origin;
    try { host = new URL(session.origin).hostname; } catch (_) {}
    const originChip = `<span class="v2-card-origin">${host}</span>`;
    if (isActive) {
      meta.innerHTML = `<span class="v2-card-active-pill"><span class="v2-live-dot"></span>active</span>${originChip}`;
    } else {
      meta.innerHTML = originChip;
    }
    body.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'v2-card-actions';
    if (isActive) {
      const check = document.createElement('div');
      check.className = 'v2-card-check';
      check.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      actions.appendChild(check);
    } else {
      const delBtn = document.createElement('button');
      delBtn.className = 'v2-card-del';
      delBtn.title = 'Delete';
      delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete session "${session.name || session.id}"?`)) return;
        await chrome.runtime.sendMessage({ action: 'deleteSession', payload: { sessionId: session.id } });
        const list = await getSavedSessions(session.origin);
        await setSavedSessions(session.origin, list.filter(s => s.id !== session.id));
        await new Promise(r => chrome.storage.local.remove([`cookies_${session.id}`, `ls_${session.id}`], r));
        card.remove();
        const c = document.getElementById('sessionCount');
        if (c) c.textContent = Math.max(0, parseInt(c.textContent || '0') - 1);
      });
      actions.appendChild(delBtn);
    }

    card.appendChild(bar);
    card.appendChild(mark);
    card.appendChild(body);
    card.appendChild(actions);

    if (!isActive) {
      card.addEventListener('click', () => {
        if (sameOrigin) {
          switchToSession(tabId, session.id);
        } else if (/^https?:\/\//.test(session.origin)) {
          chrome.runtime.sendMessage({
            action: 'createSessionTab',
            payload: { url: session.origin + '/', sessionId: session.id }
          }).then(() => window.close());
        }
      });
    }

    list.appendChild(card);
  });
}

function updateHero(currentSessionId, sessionObj, hue) {
  const heroSection = document.getElementById('heroSection');
  const heroMark    = document.getElementById('heroMark');
  const heroName    = document.getElementById('heroName');
  const heroMeta    = document.getElementById('heroMeta');

  if (currentSessionId === 'default' || !sessionObj) {
    heroSection.style.setProperty('--hue', '210');
    heroMark.className = 'v2-hero-mark v2-mark-default';
    heroName.textContent = 'Default';
    heroMeta.textContent = 'No session scoped';
    heroMeta.innerHTML = 'No session scoped';
  } else {
    heroSection.style.setProperty('--hue', hue);
    heroMark.className = 'v2-hero-mark';
    heroName.textContent = sessionObj.name || sessionObj.id;
    heroMeta.innerHTML = `<span class="v2-hero-live"><span class="v2-live-dot"></span> live</span>`;
  }
}

function renderSessionList(container, sessions, currentSessionId, origin, tabId) {
  // Preserve the header, remove everything else
  const header = container.querySelector('.v2-list-head');
  while (container.lastChild && container.lastChild !== header) {
    container.removeChild(container.lastChild);
  }

  const countEl = document.getElementById('sessionCount');
  if (countEl) countEl.textContent = sessions.length;

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'v2-empty';
    empty.innerHTML = `
      <div class="v2-empty-icon">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M8 2l1.2 3.8L13 7l-3.8 1.2L8 12 6.8 8.2 3 7l3.8-1.2L8 2Z" fill="currentColor"/></svg>
      </div>
      <div class="v2-empty-title">No sessions yet</div>
      <div class="v2-empty-sub">Create one above to start isolating accounts.</div>
    `;
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'v2-list';
  container.appendChild(list);

  sessions.forEach((session, i) => {
    const isActive = session.id === currentSessionId;
    const hue = getSessionHue(session, i);

    const card = document.createElement('div');
    card.className = 'v2-card' + (isActive ? ' active' : '');
    card.style.setProperty('--hue', hue);
    card.style.setProperty('--i', i);

    // Left accent bar
    const bar = document.createElement('div');
    bar.className = 'v2-card-bar';

    // Mark (dot in rounded square)
    const mark = document.createElement('div');
    mark.className = 'v2-card-mark';
    const dot = document.createElement('span');
    dot.className = 'v2-card-mark-dot';
    mark.appendChild(dot);

    // Body
    const body = document.createElement('div');
    body.className = 'v2-card-body';

    const nameEl = document.createElement('div');
    nameEl.className = 'v2-card-name';
    nameEl.textContent = session.name || session.id;
    nameEl.title = session.name || session.id;
    body.appendChild(nameEl);

    if (isActive) {
      const meta = document.createElement('div');
      meta.className = 'v2-card-meta';
      meta.innerHTML = `<span class="v2-card-active-pill"><span class="v2-live-dot"></span>active</span>`;
      body.appendChild(meta);
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'v2-card-actions';

    if (isActive) {
      const check = document.createElement('div');
      check.className = 'v2-card-check';
      check.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      actions.appendChild(check);
    } else {
      // Duplicate button
      const dupBtn = document.createElement('button');
      dupBtn.className = 'v2-card-dup';
      dupBtn.title = 'Duplicate session';
      dupBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3 11H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
      dupBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        dupBtn.disabled = true;
        await chrome.runtime.sendMessage({
          action: 'duplicateSession',
          payload: { sessionId: session.id, origin }
        });
        const fresh = await getSavedSessions(origin);
        renderSessionList(savedList, fresh, currentSessionId, origin, tabId);
      });

      // Rename button
      const renameBtn = document.createElement('button');
      renameBtn.className = 'v2-card-rename';
      renameBtn.title = 'Rename';
      renameBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M11 2.5a1.5 1.5 0 0 1 2.12 2.12L4.85 12.88l-2.83.7.7-2.83L11 2.5Z" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startRename(card, nameEl, renameBtn, session, origin, tabId, currentSessionId);
      });

      // Delete button
      const delBtn = document.createElement('button');
      delBtn.className = 'v2-card-del';
      delBtn.title = 'Delete';
      delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete session "${session.name || session.id}"?`)) return;

        await chrome.runtime.sendMessage({ action: 'deleteSession', payload: { sessionId: session.id } });

        const currentSaved = await getSavedSessions(origin);
        await setSavedSessions(origin, currentSaved.filter(s => s.id !== session.id));
        await new Promise(resolve => chrome.storage.local.remove([`cookies_${session.id}`, `ls_${session.id}`], resolve));

        card.remove();

        const countEl = document.getElementById('sessionCount');
        if (countEl) countEl.textContent = Math.max(0, parseInt(countEl.textContent || '0') - 1);
      });

      actions.appendChild(dupBtn);
      actions.appendChild(renameBtn);
      actions.appendChild(delBtn);
    }

    card.appendChild(bar);
    card.appendChild(mark);
    card.appendChild(body);
    card.appendChild(actions);

    if (!isActive) {
      card.addEventListener('click', () => switchToSession(tabId, session.id));
    }

    list.appendChild(card);
  });
}

async function switchToSession(tabId, sessionId) {
  await chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId } });
  chrome.tabs.reload(tabId);
  window.close();
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getSavedSessions(origin) {
  return new Promise(resolve => {
    chrome.storage.local.get([`list_${origin}`], result => resolve(result[`list_${origin}`] || []));
  });
}

function setSavedSessions(origin, list) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [`list_${origin}`]: list }, resolve);
  });
}

async function renameSession(origin, sessionId, newName) {
  if (!newName || !newName.trim()) return false;
  const sessions = await getSavedSessions(origin);
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx === -1) return false;
  sessions[idx].name = newName.trim();
  await setSavedSessions(origin, sessions);
  return sessions[idx];
}

function startRename(card, nameEl, renameBtn, session, origin, tabId, currentSessionId) {
  if (card.querySelector('.v2-rename-input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'v2-rename-input';
  input.value = session.name || session.id;
  input.maxLength = 40;

  nameEl.replaceWith(input);
  renameBtn.style.opacity = '0';
  renameBtn.style.pointerEvents = 'none';
  input.focus();
  input.select();

  let committed = false;

  async function commit() {
    if (committed) return;
    committed = true;
    input.disabled = true;

    const newName = input.value.trim() || session.name || session.id;
    session.name = newName;
    await renameSession(origin, session.id, newName);

    const newSpan = document.createElement('div');
    newSpan.className = 'v2-card-name';
    newSpan.textContent = newName;
    newSpan.title = newName;
    input.replaceWith(newSpan);

    renameBtn.style.opacity = '';
    renameBtn.style.pointerEvents = '';
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      startRename(card, newSpan, renameBtn, session, origin, tabId, currentSessionId);
    };

    if (session.id === currentSessionId) {
      document.getElementById('heroName').textContent = newName;
    }

    chrome.runtime.sendMessage({ action: 'refreshBadge', payload: { tabId } });
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') {
      committed = true;
      input.disabled = true;
      const span = document.createElement('div');
      span.className = 'v2-card-name';
      span.textContent = session.name || session.id;
      span.title = session.name || session.id;
      input.replaceWith(span);
      renameBtn.style.opacity = '';
      renameBtn.style.pointerEvents = '';
      renameBtn.onclick = (e2) => {
        e2.stopPropagation();
        startRename(card, span, renameBtn, session, origin, tabId, currentSessionId);
      };
    }
  });

  input.addEventListener('blur', () => commit());
}
