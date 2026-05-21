// popup-render-global-list.ts — Renders the "All sessions" cross-origin list.

import type { PopupSession } from './popup-types.js';
import { getSessionHue } from './popup-types.js';
import { getSavedSessions, setSavedSessions } from './popup-session-storage.js';

export function renderGlobalList(
  container: HTMLElement,
  sessions: PopupSession[],
  currentSessionId: string,
  currentOrigin: string,
  tabId: number,
  query: string
): void {
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
  if (countEl) countEl.textContent = String(filtered.length);

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
    card.style.setProperty('--hue', String(hue));
    card.style.setProperty('--i', String(i));

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
    let host = '';
    try { host = new URL(session.origin!).hostname; } catch (_) { host = session.origin || ''; }
    const originChip = document.createElement('span');
    originChip.className = 'v2-card-origin';
    originChip.textContent = host;
    if (isActive) {
      const activePill = document.createElement('span');
      activePill.className = 'v2-card-active-pill';
      activePill.innerHTML = `<span class="v2-live-dot"></span>active`;
      meta.appendChild(activePill);
    }
    meta.appendChild(originChip);
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
      delBtn.setAttribute('aria-label', `Delete session ${session.name || session.id}`);
      delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete session "${session.name || session.id}"?`)) return;
        await chrome.runtime.sendMessage({ action: 'deleteSession', payload: { sessionId: session.id } });
        const sessionList = await getSavedSessions(session.origin!);
        await setSavedSessions(session.origin!, sessionList.filter(s => s.id !== session.id));
        await new Promise<void>(r => chrome.storage.local.remove([`cookies_${session.id}`, `ls_${session.id}`], r));
        card.remove();
        const c = document.getElementById('sessionCount');
        if (c) c.textContent = String(Math.max(0, parseInt(c.textContent || '0') - 1));
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
          chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId: session.id } })
            .then(() => { chrome.tabs.reload(tabId); window.close(); });
        } else if (/^https?:\/\//.test(session.origin || '')) {
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
