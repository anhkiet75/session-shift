// popup-render-profile-list.ts — Renders the single global profile list with
// search, rename, recolor, duplicate, and delete. A profile spans all sites, so
// switching applies to the current tab.

import type { PopupSession } from './popup-types.js';
import { getSessionHue } from './popup-types.js';
import { getSavedSessions, setSavedSessions } from './popup-session-storage.js';
import { buildColorDot } from './popup-color-picker.js';
import { startRename } from './popup-rename-handler.js';
import { startDeleteConfirm, cancelActiveConfirm } from './popup-delete-handler.js';
import { attachOpenInTabMenu } from './popup-open-in-tab-menu.js';
import type { Localizer } from '../lib/localization.js';

export function renderSessionList(
  container: HTMLElement,
  sessions: PopupSession[],
  currentSessionId: string,
  tabId: number,
  currentUrl: string,
  localizer: Localizer,
  query = ''
): void {
  cancelActiveConfirm();

  const header = container.querySelector('.v2-list-head');
  while (container.lastChild && container.lastChild !== header) {
    container.removeChild(container.lastChild);
  }

  const q = query.toLowerCase().trim();
  const filtered = q
    ? sessions.filter(s => (s.name || '').toLowerCase().includes(q))
    : sessions;

  const countEl = document.getElementById('sessionCount');
  if (countEl) countEl.textContent = String(filtered.length);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'v2-empty';

    if (sessions.length === 0) {
      const iconWrap = document.createElement('div');
      iconWrap.className = 'v2-empty-icon';
      iconWrap.innerHTML = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M8 2l1.2 3.8L13 7l-3.8 1.2L8 12 6.8 8.2 3 7l3.8-1.2L8 2Z" fill="currentColor"/></svg>';
      const title = document.createElement('div');
      title.className = 'v2-empty-title';
      title.textContent = localizer.getMessage('emptyNoProfilesTitle') || 'No profiles yet';
      const sub = document.createElement('div');
      sub.className = 'v2-empty-sub';
      sub.textContent = localizer.getMessage('emptyNoProfilesSub') || 'Create one above to start isolating accounts.';
      empty.append(iconWrap, title, sub);
    } else {
      const title = document.createElement('div');
      title.className = 'v2-empty-title';
      title.textContent = localizer.getMessage('emptyNoMatchesTitle') || 'No matches';
      const sub = document.createElement('div');
      sub.className = 'v2-empty-sub';
      sub.textContent = localizer.getMessage('emptyNoMatchesSub') || 'Try a different search.';
      empty.append(title, sub);
    }

    container.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'v2-list';
  container.appendChild(list);

  filtered.forEach((session, i) => {
    const isActive = session.id === currentSessionId;
    const hue = getSessionHue(session, i);
    const displayName = session.name || session.id;

    const card = document.createElement('div');
    card.className = 'v2-card' + (isActive ? ' active' : '');
    card.style.setProperty('--hue', String(hue));
    card.style.setProperty('--i', String(i));

    // Color dot — dispatches sessionColorChanged so popup.ts can update the hero
    const colorDot = buildColorDot(session, card, (newHue) => {
      card.dispatchEvent(new CustomEvent('sessionColorChanged', {
        bubbles: true,
        detail: { sessionId: session.id, hue: newHue }
      }));
    }, localizer);

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
    nameEl.textContent = displayName;
    nameEl.title = displayName;
    body.appendChild(nameEl);

    if (isActive) {
      const meta = document.createElement('div');
      meta.className = 'v2-card-meta';
      const pill = document.createElement('span');
      pill.className = 'v2-card-active-pill';
      const liveDot = document.createElement('span');
      liveDot.className = 'v2-live-dot';
      pill.appendChild(liveDot);
      pill.appendChild(document.createTextNode(localizer.getMessage('activeStatusPill') || 'active'));
      meta.appendChild(pill);
      body.appendChild(meta);
    }

    const actions = document.createElement('div');
    actions.className = 'v2-card-actions';

    const dupBtn = document.createElement('button');
    dupBtn.className = 'v2-card-dup';
    dupBtn.title = localizer.getMessage('duplicateProfileTitle') || 'Duplicate profile';
    dupBtn.setAttribute('data-action', 'duplicate-profile');
    dupBtn.setAttribute('aria-label', localizer.getMessage('duplicateProfileAriaLabel', [displayName]) || `Duplicate profile ${displayName}`);
    dupBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3 11H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    dupBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      dupBtn.disabled = true;
      await chrome.runtime.sendMessage({ action: 'duplicateSession', payload: { sessionId: session.id } });
      const fresh = await getSavedSessions();
      renderSessionList(container, fresh, currentSessionId, tabId, currentUrl, localizer, query);
    });

    const renameBtn = document.createElement('button');
    renameBtn.className = 'v2-card-rename';
    renameBtn.title = localizer.getMessage('renameTitle') || 'Rename';
    renameBtn.setAttribute('data-action', 'rename-profile');
    renameBtn.setAttribute('aria-label', localizer.getMessage('renameAriaLabel', [displayName]) || `Rename profile ${displayName}`);
    renameBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M11 2.5a1.5 1.5 0 0 1 2.12 2.12L4.85 12.88l-2.83.7.7-2.83L11 2.5Z" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(card, nameEl, renameBtn, session, tabId, currentSessionId);
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
      delBtn.title = localizer.getMessage('deleteTitle') || 'Delete';
      delBtn.setAttribute('data-action', 'delete-profile');
      delBtn.setAttribute('aria-label', localizer.getMessage('deleteAriaLabel', [displayName]) || `Delete profile ${displayName}`);
      delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startDeleteConfirm(actions, [dupBtn, renameBtn, delBtn], async () => {
          await chrome.runtime.sendMessage({ action: 'deleteSession', payload: { sessionId: session.id } });
          const current = await getSavedSessions();
          await setSavedSessions(current.filter(s => s.id !== session.id));
          await new Promise<void>(resolve => chrome.storage.local.remove([`cookies_${session.id}`], resolve));
          card.remove();
          const c = document.getElementById('sessionCount');
          if (c) c.textContent = String(Math.max(0, parseInt(c.textContent || '0') - 1));
        }, localizer);
      });
      actions.appendChild(delBtn);
    }

    card.appendChild(colorDot);
    card.appendChild(bar);
    card.appendChild(mark);
    card.appendChild(body);
    card.appendChild(actions);
    attachOpenInTabMenu(card, session, () => currentUrl, localizer);

    if (!isActive) {
      card.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId: session.id } })
          .then(() => { chrome.tabs.reload(tabId); window.close(); });
      });
    }

    list.appendChild(card);
  });
}
