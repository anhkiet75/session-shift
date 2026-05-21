// popup-rename-handler.ts — Inline rename input for session cards.

import type { PopupSession } from './popup-types.js';
import { renameSession } from './popup-session-storage.js';

export function startRename(
  card: HTMLElement,
  nameEl: HTMLElement,
  renameBtn: HTMLButtonElement,
  session: PopupSession,
  origin: string,
  tabId: number,
  currentSessionId: string
): void {
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

  async function commit(): Promise<void> {
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
      document.getElementById('heroName')!.textContent = newName;
    }
    chrome.runtime.sendMessage({ action: 'refreshBadge', payload: { tabId } });
  }

  input.addEventListener('keydown', (e: KeyboardEvent) => {
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
