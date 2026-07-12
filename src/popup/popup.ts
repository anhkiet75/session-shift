// popup.ts — Entry point. Wires DOM events and delegates to focused modules.

import { HUE_PALETTE, getSessionHue } from './popup-types.js';
import type { PopupSession } from './popup-types.js';
import { applyStoredTheme, cycleTheme } from './popup-theme.js';
import { getSavedSessions, setSavedSessions } from './popup-session-storage.js';
import { updateHero } from './popup-hero-updater.js';
import { renderSessionList } from './popup-render-profile-list.js';
import { getLanguagePreference, createLocalizer, applyDocumentLocale, localizeDocument } from '../lib/localization.js';
import type { Localizer } from '../lib/localization.js';

async function getCurrentTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Never throws — the last-resort fallback if even `createLocalizer('system')` fails. */
function inertFallbackLocalizer(): Localizer {
  return { preference: 'system', languageTag: 'en', direction: 'ltr', getMessage: () => '' };
}

async function resolveLocalizer(): Promise<Localizer> {
  try {
    return await createLocalizer(await getLanguagePreference());
  } catch {
    // Recoverable failure: fall back to native System resolution.
  }
  try {
    return await createLocalizer('system');
  } catch {
    // Both resolutions failed — degrade to English-fallback-only rather than
    // throw. Static markup already carries valid English text, and
    // `localizeDocument` skips (not blanks) any key this resolves to ''.
    return inertFallbackLocalizer();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const popupRoot = document.querySelector('.v2-popup') as HTMLElement | null;
  const reveal = (): void => {
    popupRoot?.removeAttribute('inert');
    popupRoot?.removeAttribute('aria-busy');
  };

  try {
    const localizer = await resolveLocalizer();
    applyDocumentLocale(document, localizer);
    localizeDocument(document, localizer);

    await applyStoredTheme(localizer);
    document.getElementById('themeToggle')?.addEventListener('click', () => cycleTheme(localizer));
    document.getElementById('openOptions')?.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });
    const currentTab = await getCurrentTab();

    if (!currentTab.url || !/^https?:/.test(currentTab.url)) {
      const msg = document.createElement('div');
      msg.style.cssText = 'padding:24px 16px;text-align:center;font-size:12px;font-weight:500;color:var(--text-muted);';
      msg.textContent = localizer.getMessage('cannotIsolatePage') || 'Cannot isolate this page.';
      popupRoot!.appendChild(msg);
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

    updateHero(currentSessionId, currentSessionObj, currentHue, localizer);

    // Hero + cached list sync when a profile color changes
    savedList.addEventListener('sessionColorChanged', (e: Event) => {
      const { sessionId, hue } = (e as CustomEvent<{ sessionId: string; hue: number }>).detail;
      if (sessionId === currentSessionId && currentSessionObj) {
        currentSessionObj = { ...currentSessionObj, hue };
        currentHue = hue;
        updateHero(currentSessionId, currentSessionObj, hue, localizer);
      }
      const cached = saved.find(s => s.id === sessionId);
      if (cached) cached.hue = hue;
    });

    btnDefault.disabled = currentSessionId === 'default';

    function buildResetButton(): HTMLButtonElement {
      const btn = document.createElement('button');
      btn.id = 'btnDefault';
      btn.className = 'v2-reset';
      btn.disabled = currentSessionId === 'default';
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8a5 5 0 1 0 1.5-3.5M3 3v3h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const label = document.createElement('span');
      label.textContent = localizer.getMessage('resetToDefault') || 'Reset to default';
      btn.appendChild(label);
      return btn;
    }

    function showResetButton(): void {
      resetArea.replaceChildren(buildResetButton());
      document.getElementById('btnDefault')!.addEventListener('click', showConfirm);
    }

    function showConfirm(): void {
      const confirmWrap = document.createElement('div');
      confirmWrap.className = 'v2-confirm';
      const question = document.createElement('span');
      question.textContent = localizer.getMessage('switchToDefaultConfirm') || 'Switch to default?';
      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'v2-confirm-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'v2-btn-ghost';
      cancelBtn.id = 'btnCancelReset';
      cancelBtn.textContent = localizer.getMessage('cancelButton') || 'Cancel';
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'v2-btn-danger';
      confirmBtn.id = 'btnConfirmReset';
      confirmBtn.textContent = localizer.getMessage('resetButton') || 'Reset';
      actionsWrap.append(cancelBtn, confirmBtn);
      confirmWrap.append(question, actionsWrap);
      resetArea.replaceChildren(confirmWrap);

      cancelBtn.addEventListener('click', showResetButton);
      confirmBtn.addEventListener('click', async () => {
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
        || localizer.getMessage('generatedSessionName', [String(saved.length + 1)])
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
      renderSessionList(savedList, saved, currentSessionId, currentTab.id!, currentTab.url!, localizer, searchQuery);
    }

    renderList();

    searchInput.addEventListener('input', (e) => {
      searchQuery = (e.target as HTMLInputElement).value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(renderList, 80);
    });
  } finally {
    // Always reveal — a thrown error above must not leave the popup
    // permanently inert/blank.
    reveal();
  }
});
