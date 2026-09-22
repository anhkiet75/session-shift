// popup-save-favorite.ts — Hero star. Saves the current tab as a favorite bound
// to that tab's active profile, and removes it again on a second click.
//
// Disabled (with an explanatory title) when there is nothing meaningful to
// save: a non-http(s) page, or a tab still on the default profile.

import { addFavorite, deleteFavorite, findFavorite } from '../lib/favorites-store.js';
import type { Favorite } from '../lib/types.js';
import type { Localizer } from '../lib/localization.js';

export interface SaveFavoriteContext {
  button: HTMLButtonElement
  /** Current tab URL — may carry any scheme; non-http(s) disables the star. */
  url: string
  /** Page-supplied tab title, used as the default label. Rendered via textContent only. */
  title: string
  /** Profile currently active on this tab, or `'default'`. */
  sessionId: string
  localizer: Localizer
}

export interface SaveFavoriteHandle {
  /** Re-read the store and repaint — called when the favorites list mutates elsewhere. */
  refresh(): Promise<void>
}

function disable(button: HTMLButtonElement, title: string): void {
  button.disabled = true;
  button.setAttribute('aria-pressed', 'false');
  button.classList.remove('saved');
  button.title = title;
}

export async function initSaveFavoriteButton(context: SaveFavoriteContext): Promise<SaveFavoriteHandle> {
  const { button, url, sessionId, localizer } = context;
  const text = (key: string, fallback: string): string => localizer.getMessage(key) || fallback;

  button.setAttribute('aria-label', text('saveFavoriteAriaLabel', 'Save as favorite'));

  if (!/^https?:/.test(url)) {
    disable(button, text('saveFavoriteUnavailableTitle', 'This page cannot be saved as a favorite.'));
    return { refresh: async () => {} };
  }

  if (sessionId === 'default') {
    // A default-bound favorite would switch nothing, and `createSessionTab`
    // rejects `sessionId: 'default'` outright — so there is nothing to save.
    disable(button, text('saveFavoriteDefaultDisabledTitle', 'Switch this tab to a profile first to save it as a favorite.'));
    return { refresh: async () => {} };
  }

  let current: Favorite | null = null;

  function paint(): void {
    const saved = current !== null;
    button.setAttribute('aria-pressed', String(saved));
    button.classList.toggle('saved', saved);
    button.title = saved
      ? text('savedFavoriteTitle', 'Saved — click to remove')
      : text('saveFavoriteTitle', 'Save as favorite');
  }

  async function refresh(): Promise<void> {
    current = await findFavorite(url, sessionId);
    paint();
  }

  await refresh();

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (current) {
        await deleteFavorite(current.id);
        current = null;
      } else {
        const result = await addFavorite({ url, sessionId, label: context.title });
        if (result.status === 'limit') {
          // Leave the star unpressed and say why, rather than failing silently.
          button.title = text('favoritesLimitReached', 'Favorite limit reached.');
          return;
        }
        current = result.status === 'added' || result.status === 'exists' ? result.favorite : null;
      }
      paint();
      document.dispatchEvent(new CustomEvent('favoritesChanged'));
    } finally {
      button.disabled = false;
    }
  });

  return { refresh };
}
