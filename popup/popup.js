// popup.js

const COLOR_PALETTE = ['#7c3aed', '#2563eb', '#059669', '#d97706', '#dc2626', '#db2777', '#0891b2'];

document.addEventListener('DOMContentLoaded', async () => {
  const { version } = chrome.runtime.getManifest();
  document.getElementById('versionChip').textContent = `v${version}`;
  const currentTab = await getCurrentTab();

  // Handle chrome:// and other non-http pages
  if (!currentTab.url || currentTab.url.startsWith('chrome://') || currentTab.url.startsWith('chrome-extension://') || currentTab.url.startsWith('about:')) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'margin-top:8px;text-align:center;padding:24px 16px;';
    const msg = document.createElement('p');
    msg.style.cssText = 'font-size:12px;font-weight:500;color:rgba(238,238,245,0.4);';
    msg.textContent = 'Cannot isolate this page.';
    card.appendChild(msg);
    document.querySelector('.container').appendChild(card);
    return;
  }

  const origin = new URL(currentTab.url).origin;

  // Elements
  const elCurrentSession = document.getElementById('currentSession');
  const btnDefault = document.getElementById('btnDefault');
  const btnNewSession = document.getElementById('btnNewSession');
  const newSessionName = document.getElementById('newSessionName');
  const savedSessionsList = document.getElementById('savedSessionsList');

  // Fetch current session for the tab
  const activeSessionResponse = await chrome.runtime.sendMessage({
    action: "getSession",
    payload: { tabId: currentTab.id }
  });

  const currentSessionId = activeSessionResponse?.sessionId || 'default';

  // Render current session badge
  const saved = await getSavedSessions(origin);
  const currentSessionObj = saved.find(s => s.id === currentSessionId);

  if (currentSessionId === 'default') {
    elCurrentSession.textContent = 'Default';
    elCurrentSession.className = 'badge badge-default';
  } else {
    elCurrentSession.textContent = currentSessionObj ? currentSessionObj.name : currentSessionId;
    elCurrentSession.className = 'badge badge-active';
    // Color is handled by CSS (.badge-active uses Swiss Red)
  }

  // Action: Reset to Default
  btnDefault.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: "setSession", payload: { tabId: currentTab.id, sessionId: 'default' } });
    chrome.tabs.reload(currentTab.id);
    window.close();
  });

  // Action: Create New Session
  btnNewSession.addEventListener('click', async () => {
    const newId = "session_" + Math.random().toString(36).substring(2, 9);
    const userInput = newSessionName.value.trim();
    const name = userInput || newId;

    const sessions = await getSavedSessions(origin);
    const color = COLOR_PALETTE[sessions.length % COLOR_PALETTE.length];
    const newSession = { id: newId, name, color };

    sessions.push(newSession);
    await setSavedSessions(origin, sessions);

    await chrome.runtime.sendMessage({ action: 'createSessionTab', payload: { url: currentTab.url, sessionId: newId } });
    window.close();
  });

  // Render saved sessions list
  renderSessionList(savedSessionsList, saved, currentSessionId, origin, currentTab.id);
});

function renderSessionList(container, sessions, currentSessionId, origin, tabId) {
  const label = container.querySelector('.label');
  while (container.firstChild) container.removeChild(container.firstChild);
  if (label) container.appendChild(label);

  if (sessions.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'empty-msg';
    msg.textContent = '// no sessions yet';
    container.appendChild(msg);
    return;
  }

  const list = document.createElement('div');
  list.className = 'sessions-list';
  container.appendChild(list);

  sessions.forEach(session => {
    const isActive = session.id === currentSessionId;
    const div = document.createElement('div');
    div.className = 'session-item' + (isActive ? ' session-item-active' : '');

    const dot = document.createElement('span');
    dot.className = 'color-dot';
    dot.style.backgroundColor = session.color || '#7c3aed';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'session-item-name';
    nameSpan.textContent = session.name || session.id;
    nameSpan.title = session.name || session.id;

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-sm btn-rename';
    renameBtn.title = 'Rename session';
    renameBtn.textContent = '✎';
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      startRename(div, nameSpan, renameBtn, session, origin, tabId, currentSessionId);
    };

    const switchBtn = document.createElement('button');
    switchBtn.className = 'btn-sm btn-switch';
    switchBtn.textContent = isActive ? 'Active' : 'Switch';
    switchBtn.disabled = isActive;
    switchBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await switchToSession(tabId, session.id);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-sm btn-delete';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Delete session';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete session "${session.name || session.id}"?`)) return;

      await chrome.runtime.sendMessage({ action: "deleteSession", payload: { sessionId: session.id } });

      const currentSaved = await getSavedSessions(origin);
      const updated = currentSaved.filter(s => s.id !== session.id);
      await setSavedSessions(origin, updated);

      await new Promise(resolve => {
        chrome.storage.local.remove([`cookies_${session.id}`, `ls_${session.id}`], resolve);
      });

      div.remove();

      if (isActive) {
        await chrome.runtime.sendMessage({ action: "setSession", payload: { tabId, sessionId: 'default' } });
        chrome.tabs.reload(tabId);
        window.close();
      }
    });

    div.appendChild(dot);
    div.appendChild(nameSpan);
    div.appendChild(renameBtn);
    div.appendChild(switchBtn);
    div.appendChild(deleteBtn);
    list.appendChild(div);
  });
}

async function switchToSession(tabId, sessionId) {
  await chrome.runtime.sendMessage({ action: "setSession", payload: { tabId, sessionId } });
  chrome.tabs.reload(tabId);
  window.close();
}

async function getCurrentTab() {
  const queryOptions = { active: true, currentWindow: true };
  const [tab] = await chrome.tabs.query(queryOptions);
  return tab;
}

function getSavedSessions(origin) {
  return new Promise((resolve) => {
    chrome.storage.local.get([`list_${origin}`], (result) => {
      resolve(result[`list_${origin}`] || []);
    });
  });
}

function setSavedSessions(origin, list) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [`list_${origin}`]: list }, () => {
      resolve();
    });
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

function startRename(div, nameSpan, renameBtn, session, origin, tabId, currentSessionId) {
  // Prevent double-activating
  if (div.querySelector('.rename-input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = session.name || session.id;
  input.maxLength = 40;

  // Swap span → input
  nameSpan.replaceWith(input);
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

    const updated = await renameSession(origin, session.id, newName);

    const newSpan = document.createElement('span');
    newSpan.className = 'session-item-name';
    newSpan.textContent = newName;
    newSpan.title = newName;
    input.replaceWith(newSpan);
    renameBtn.style.opacity = '';
    renameBtn.style.pointerEvents = '';

    renameBtn.onclick = (e) => {
      e.stopPropagation();
      startRename(div, newSpan, renameBtn, session, origin, tabId, currentSessionId);
    };

    if (updated) {
      // Refresh the extension badge on the tab if this session is active there
      chrome.runtime.sendMessage({ action: 'refreshBadge', payload: { tabId } });
      // Also update the popup header badge if this is the currently active session
      if (session.id === currentSessionId) {
        const badge = document.getElementById('currentSession');
        if (badge) badge.textContent = newName;
      }
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') {
      committed = true;
      input.disabled = true;
      const span = document.createElement('span');
      span.className = 'session-item-name';
      span.textContent = session.name || session.id;
      span.title = session.name || session.id;
      input.replaceWith(span);
      renameBtn.style.opacity = '';
      renameBtn.style.pointerEvents = '';
      renameBtn.onclick = (e2) => {
        e2.stopPropagation();
        startRename(div, span, renameBtn, session, origin, tabId, currentSessionId);
      };
    }
  });

  input.addEventListener('blur', () => commit());
}
