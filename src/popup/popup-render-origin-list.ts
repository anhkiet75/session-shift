// popup-render-origin-list.ts — Renders the per-origin session list with rename + color picker.

import type { PopupSession } from './popup-types.js';
import { getSessionHue } from './popup-types.js';
import { getSavedSessions, setSavedSessions } from './popup-session-storage.js';
import { buildColorDot } from './popup-color-picker.js';
import { startRename } from './popup-rename-handler.js';
import { startDeleteConfirm, cancelActiveConfirm } from './popup-delete-handler.js';

export function renderSessionList(
  container: HTMLElement,
  sessions: PopupSession[],
  currentSessionId: string,
  origin: string,
  tabId: number
): void {
  cancelActiveConfirm();

  const header = container.querySelector('.v2-list-head');
  while (container.lastChild && container.lastChild !== header) {
    container.removeChild(container.lastChild);
  }

  const countEl = document.getElementById('sessionCount');
  if (countEl) countEl.textContent = String(sessions.length);

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
    card.style.setProperty('--hue', String(hue));
    card.style.setProperty('--i', String(i));

    // Color dot — dispatches sessionColorChanged so popup.ts can update hero
    const colorDot = buildColorDot(session, card, (newHue) => {
      if (isActive) {
        card.dispatchEvent(new CustomEvent('sessionColorChanged', {
          bubbles: true,
          detail: { sessionId: session.id, hue: newHue }
        }));
      }
    });

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

    if (isActive) {
      const meta = document.createElement('div');
      meta.className = 'v2-card-meta';
      meta.innerHTML = `<span class="v2-card-active-pill"><span class="v2-live-dot"></span>active</span>`;
      body.appendChild(meta);
    }

    const actions = document.createElement('div');
    actions.className = 'v2-card-actions';

    const dupBtn = document.createElement('button');
    dupBtn.className = 'v2-card-dup';
    dupBtn.title = 'Duplicate session';
    dupBtn.setAttribute('aria-label', `Duplicate session ${session.name || session.id}`);
    dupBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3 11H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    dupBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      dupBtn.disabled = true;
      await chrome.runtime.sendMessage({ action: 'duplicateSession', payload: { sessionId: session.id, origin } });
      const fresh = await getSavedSessions(origin);
      renderSessionList(container, fresh, currentSessionId, origin, tabId);
    });

    const renameBtn = document.createElement('button');
    renameBtn.className = 'v2-card-rename';
    renameBtn.title = 'Rename';
    renameBtn.setAttribute('aria-label', `Rename session ${session.name || session.id}`);
    renameBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M11 2.5a1.5 1.5 0 0 1 2.12 2.12L4.85 12.88l-2.83.7.7-2.83L11 2.5Z" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(card, nameEl, renameBtn, session, origin, tabId, currentSessionId);
    });

    actions.appendChild(dupBtn);
    actions.appendChild(renameBtn);

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
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startDeleteConfirm(actions, [dupBtn, renameBtn, delBtn], async () => {
          await chrome.runtime.sendMessage({ action: 'deleteSession', payload: { sessionId: session.id } });
          const current = await getSavedSessions(origin);
          await setSavedSessions(origin, current.filter(s => s.id !== session.id));
          await new Promise<void>(resolve => chrome.storage.local.remove([`cookies_${session.id}`, `ls_${session.id}`], resolve));
          card.remove();
          const c = document.getElementById('sessionCount');
          if (c) c.textContent = String(Math.max(0, parseInt(c.textContent || '0') - 1));
        });
      });
      actions.appendChild(delBtn);
    }

    card.appendChild(colorDot);
    card.appendChild(bar);
    card.appendChild(mark);
    card.appendChild(body);
    card.appendChild(actions);

    if (!isActive) {
      card.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId: session.id } })
          .then(() => { chrome.tabs.reload(tabId); window.close(); });
      });
    }

    list.appendChild(card);
  });
}
