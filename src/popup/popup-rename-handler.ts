// popup-rename-handler.ts — Inline rename input for session cards.

import type { PopupSession } from './popup-types.js';
import { renameSession } from './popup-session-storage.js';

export function startRename(
  card: HTMLElement,
  nameEl: HTMLElement,
  renameBtn: HTMLButtonElement,
  session: PopupSession,
  tabId: number,
  currentSessionId: string
): void {
  if (card.querySelector('.v2-rename-input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'v2-rename-input';
  input.dir = 'auto'; // user-supplied name: isolate its own direction while typing
  input.value = session.name || session.id;
  input.maxLength = 40;

  nameEl.replaceWith(input);
  renameBtn.style.opacity = '0';
  renameBtn.style.pointerEvents = 'none';
  input.focus();
  input.select();

  let committed = false;

  async function commit(): Promise<void> {
    if (committed) return;
    committed = true;
    input.disabled = true;

    const newName = input.value.trim() || session.name || session.id;
    session.name = newName;
    await renameSession(session.id, newName);

    const newSpan = document.createElement('div');
    newSpan.className = 'v2-card-name';
    newSpan.dir = 'auto';
    newSpan.textContent = newName;
    newSpan.title = newName;
    input.replaceWith(newSpan);

    renameBtn.style.opacity = '';
    renameBtn.style.pointerEvents = '';
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      startRename(card, newSpan, renameBtn, session, tabId, currentSessionId);
    };

    if (session.id === currentSessionId) {
      document.getElementById('heroName')!.textContent = newName;
    }
    chrome.runtime.sendMessage({ action: 'refreshBadge', payload: { tabId } });
    // Retitle any already-open native tab group for this profile — renameSession()
    // above only wrote chrome.storage.local, which chrome.tabGroups never reads on its own.
    chrome.runtime.sendMessage({ action: 'renameProfileGroups', payload: { sessionId: session.id } });
  }

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') {
      committed = true;
      input.disabled = true;
      const span = document.createElement('div');
      span.className = 'v2-card-name';
      span.dir = 'auto';
      span.textContent = session.name || session.id;
      span.title = session.name || session.id;
      input.replaceWith(span);
      renameBtn.style.opacity = '';
      renameBtn.style.pointerEvents = '';
      renameBtn.onclick = (e2) => {
        e2.stopPropagation();
        startRename(card, span, renameBtn, session, tabId, currentSessionId);
      };
    }
  });

  input.addEventListener('blur', () => commit());
}
