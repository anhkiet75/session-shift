// popup.ts — Entry point. Wires DOM events and delegates to focused modules.

import { HUE_PALETTE, getSessionHue } from './popup-types.js';
import type { PopupSession } from './popup-types.js';
import { applyStoredTheme, cycleTheme } from './popup-theme.js';
import { getSavedSessions, setSavedSessions } from './popup-session-storage.js';
import { updateHero } from './popup-hero-updater.js';
import { renderSessionList } from './popup-render-profile-list.js';
import { renderFavoritesList } from './popup-render-favorites-list.js';
import { initSaveFavoriteButton } from './popup-save-favorite.js';
import { getLanguagePreference, createLocalizer, applyDocumentLocale, localizeDocument, createGenerationGuard } from '../lib/localization.js';
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
    const currentUrl = currentTab.url ?? '';
    // Favorites stay reachable on pages that cannot be isolated — launching one
    // from a new-tab or chrome:// page is the main reason to open the popup
    // there. Only the profile area is replaced by the "cannot isolate" notice.
    const canIsolate = /^https?:/.test(currentUrl);

    const inputEl       = document.getElementById('newSessionName') as HTMLInputElement;
    const createRow     = document.getElementById('createRow')!;
    const btnNewSession = document.getElementById('btnNewSession') as HTMLButtonElement;
    const savedList     = document.getElementById('savedSessionsList')!;
    const resetArea     = document.getElementById('resetArea')!;
    const btnDefault    = document.getElementById('btnDefault') as HTMLButtonElement;
    const favoritesSection = document.getElementById('favoritesSection')!;
    const searchInput   = document.getElementById('searchInput') as HTMLInputElement;

    const activeSessionResponse = canIsolate
      ? await chrome.runtime.sendMessage({
          action: 'getSession',
          payload: { tabId: currentTab.id }
        }) as { sessionId?: string } | null
      : null;
    const currentSessionId = activeSessionResponse?.sessionId || 'default';

    let saved = await getSavedSessions();

    let searchQuery = '';
    let searchTimer: ReturnType<typeof setTimeout> | null = null;

    function renderList(): void {
      renderSessionList(savedList, saved, currentSessionId, currentTab.id!, currentUrl, localizer, searchQuery);
    }

    // Renders are fire-and-forget from two call sites (search input, storage
    // change), so a slower earlier read could otherwise repaint over a newer
    // one. Same guard the Options language picker uses for the same problem.
    const favoritesGuard = createGenerationGuard();

    async function renderFavorites(): Promise<void> {
      const generation = favoritesGuard.next();
      await renderFavoritesList(favoritesSection, saved, localizer, searchQuery,
        () => favoritesGuard.isLatest(generation));
    }

    // Favorites are an optional section: a fault here (storage rejects, one
    // malformed stored entry) must never abort the wiring below and leave the
    // user a popup that cannot switch, create or reset a profile. Fail closed
    // and silently — the section simply does not appear.
    const star = await initSaveFavoriteButton({
      button: document.getElementById('saveFavorite') as HTMLButtonElement,
      url: currentUrl,
      title: currentTab.title ?? '',
      sessionId: currentSessionId,
      localizer,
    }).catch(() => ({ refresh: async (): Promise<void> => {} }));

    await renderFavorites().catch(() => {});

    // Saving from the star and removing from a row both mutate the same key;
    // repaint whichever surface did not originate the change.
    document.addEventListener('favoritesChanged', () => {
      void renderFavorites().catch(() => {});
      void star.refresh().catch(() => {});
    });

    searchInput.addEventListener('input', (e) => {
      searchQuery = (e.target as HTMLInputElement).value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        void renderFavorites().catch(() => {});
        if (canIsolate) renderList();
      }, 80);
    });

    if (!canIsolate) {
      const msg = document.createElement('div');
      msg.style.cssText = 'padding:24px 16px;text-align:center;font-size:12px;font-weight:500;color:var(--text-muted);';
      msg.textContent = localizer.getMessage('cannotIsolatePage') || 'Cannot isolate this page.';
      savedList.replaceChildren(msg);
      createRow.classList.add('hidden');
      btnDefault.disabled = true;
      return;
    }
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
        // Bypass cache — same reasoning as the profile-switch reload: the
        // disk cache spans every profile, so a cached response could still
        // reflect the profile just left.
        chrome.tabs.reload(currentTab.id!, { bypassCache: true });
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
      await chrome.runtime.sendMessage({ action: 'createSessionTab', payload: { url: currentUrl, sessionId: newId } });
      window.close();
    });

    inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') btnNewSession.click();
    });

    renderList();
  } finally {
    // Always reveal — a thrown error above must not leave the popup
    // permanently inert/blank.
    reveal();
  }
});
