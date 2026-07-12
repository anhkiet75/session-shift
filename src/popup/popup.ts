// popup.ts — Entry point. Wires DOM events and delegates to focused modules.

import { HUE_PALETTE, getSessionHue } from './popup-types.js';
import type { PopupSession } from './popup-types.js';
import { applyStoredTheme, cycleTheme } from './popup-theme.js';
import { getSavedSessions, setSavedSessions } from './popup-session-storage.js';
import { updateHero } from './popup-hero-updater.js';
import { renderSessionList } from './popup-render-profile-list.js';

async function getCurrentTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

document.addEventListener('DOMContentLoaded', async () => {
  await applyStoredTheme();
  document.getElementById('themeToggle')?.addEventListener('click', cycleTheme);
  document.getElementById('openOptions')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
  const currentTab = await getCurrentTab();

  if (!currentTab.url || !/^https?:/.test(currentTab.url)) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:24px 16px;text-align:center;font-size:12px;font-weight:500;color:var(--text-muted);';
    msg.textContent = 'Cannot isolate this page.';
    document.querySelector('.v2-popup')!.appendChild(msg);
    return;
  }

  const inputEl       = document.getElementById('newSessionName') as HTMLInputElement;
  const createRow     = document.getElementById('createRow')!;
  const btnNewSession = document.getElementById('btnNewSession') as HTMLButtonElement;
  const savedList     = document.getElementById('savedSessionsList')!;
  const resetArea     = document.getElementById('resetArea')!;
  const btnDefault    = document.getElementById('btnDefault') as HTMLButtonElement;

  const activeSessionResponse = await chrome.runtime.sendMessage({
    action: 'getSession',
    payload: { tabId: currentTab.id }
  }) as { sessionId?: string } | null;
  const currentSessionId = activeSessionResponse?.sessionId || 'default';

  let saved = await getSavedSessions();
  let currentSessionObj = saved.find(s => s.id === currentSessionId);
  let currentHue = currentSessionObj ? getSessionHue(currentSessionObj, saved.indexOf(currentSessionObj)) : null;

  updateHero(currentSessionId, currentSessionObj, currentHue);

  // Hero + cached list sync when a profile color changes
  savedList.addEventListener('sessionColorChanged', (e: Event) => {
    const { sessionId, hue } = (e as CustomEvent<{ sessionId: string; hue: number }>).detail;
    if (sessionId === currentSessionId && currentSessionObj) {
      currentSessionObj = { ...currentSessionObj, hue };
      currentHue = hue;
      updateHero(currentSessionId, currentSessionObj, hue);
    }
    const cached = saved.find(s => s.id === sessionId);
    if (cached) cached.hue = hue;
  });

  btnDefault.disabled = currentSessionId === 'default';

  function showResetButton(): void {
    resetArea.innerHTML = `
      <button id="btnDefault" class="v2-reset"${currentSessionId === 'default' ? ' disabled' : ''}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8a5 5 0 1 0 1.5-3.5M3 3v3h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Reset to default
      </button>
    `;
    document.getElementById('btnDefault')!.addEventListener('click', showConfirm);
  }

  function showConfirm(): void {
    resetArea.innerHTML = `
      <div class="v2-confirm">
        <span>Switch to default?</span>
        <div class="v2-confirm-actions">
          <button class="v2-btn-ghost" id="btnCancelReset">Cancel</button>
          <button class="v2-btn-danger" id="btnConfirmReset">Reset</button>
        </div>
      </div>
    `;
    document.getElementById('btnCancelReset')!.addEventListener('click', showResetButton);
    document.getElementById('btnConfirmReset')!.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId: currentTab.id, sessionId: 'default' } });
      chrome.tabs.reload(currentTab.id!);
      window.close();
    });
  }

  btnDefault.addEventListener('click', showConfirm);

  inputEl.addEventListener('focus', () => createRow.classList.add('focused'));
  inputEl.addEventListener('blur',  () => createRow.classList.remove('focused'));

  btnNewSession.addEventListener('click', async () => {
    const newId = 'session_' + crypto.randomUUID();
    const name  = inputEl.value.trim()
      || chrome.i18n.getMessage('generatedSessionName', [String(saved.length + 1)])
      || `Session ${saved.length + 1}`;
    const hue   = HUE_PALETTE[saved.length % HUE_PALETTE.length];
    const newSession: PopupSession = { id: newId, name, hue };
    const sessions = await getSavedSessions();
    sessions.push(newSession);
    await setSavedSessions(sessions);
    await chrome.runtime.sendMessage({ action: 'createSessionTab', payload: { url: currentTab.url, sessionId: newId } });
    window.close();
  });

  inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') btnNewSession.click();
  });

  let searchQuery = '';
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  const searchInput = document.getElementById('searchInput') as HTMLInputElement;

  function renderList(): void {
    renderSessionList(savedList, saved, currentSessionId, currentTab.id!, currentTab.url!, searchQuery);
  }

  renderList();

  searchInput.addEventListener('input', (e) => {
    searchQuery = (e.target as HTMLInputElement).value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(renderList, 80);
  });

});
