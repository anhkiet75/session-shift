// popup-rename-handler.ts — Inline rename input for session cards.

import type { PopupSession } from './popup-types.js';
import { renameSession } from './popup-session-storage.js';

export const RENAME_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11 2.5a1.5 1.5 0 0 1 2.12 2.12L4.85 12.88l-2.83.7.7-2.83L11 2.5Z" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const CONFIRM_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Swap the card's name for an input. Enter, blur, or the rename button (shown
 * as a check while editing) saves; Escape backs out. The name element is
 * looked up on each call, so the button's single click listener keeps working
 * after the name node is replaced by a rename.
 */
export function startRename(
  card: HTMLElement,
  renameBtn: HTMLButtonElement,
  session: PopupSession,
  tabId: number,
  currentSessionId: string
): void {
  const existing = card.querySelector<HTMLInputElement>('.v2-rename-input');
  // Second press on the (now check) button: the blur below commits.
  if (existing) { existing.blur(); return; }
  const nameEl = card.querySelector<HTMLElement>('.v2-card-name');
  if (!nameEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'v2-rename-input';
  input.dir = 'auto'; // user-supplied name: isolate its own direction while typing
  input.value = session.name || session.id;
  input.maxLength = 40;
  // Clicking into the input must not bubble up and switch to this profile.
  input.addEventListener('click', (e) => e.stopPropagation());

  nameEl.replaceWith(input);
  renameBtn.innerHTML = CONFIRM_ICON;
  renameBtn.classList.add('editing');
  // Keep focus in the input on press so the click is the one that saves
  // (otherwise blur saves first and the click would reopen the editor).
  const keepFocus = (e: MouseEvent): void => { e.preventDefault(); };
  renameBtn.addEventListener('mousedown', keepFocus);
  input.focus();
  input.select();

  let done = false;

  function finish(name: string): void {
    const span = document.createElement('div');
    span.className = 'v2-card-name';
    span.dir = 'auto';
    span.textContent = name;
    span.title = name;
    input.replaceWith(span);
    renameBtn.innerHTML = RENAME_ICON;
    renameBtn.classList.remove('editing');
    renameBtn.removeEventListener('mousedown', keepFocus);
  }

  async function commit(): Promise<void> {
    if (done) return;
    done = true;
    input.disabled = true;

    const newName = input.value.trim() || session.name || session.id;
    session.name = newName;
    await renameSession(session.id, newName);
    finish(newName);

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
      e.preventDefault();
      done = true;
      input.disabled = true;
      finish(session.name || session.id);
    }
  });

  input.addEventListener('blur', () => commit());
}
