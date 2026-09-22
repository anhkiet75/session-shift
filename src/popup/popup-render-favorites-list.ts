// popup-render-favorites-list.ts — Favorites section. One click launches a
// saved (url, profile) pair into a new tab carrying that profile's cookies.
//
// Launch reuses the existing `createSessionTab` message verbatim — the same
// path the context menu and the profile right-click menu already use — so this
// section adds no new cookie-isolation surface.

import { getFavorites, deleteFavorite } from '../lib/favorites-store.js';
import { createInlineConfirmController } from '../lib/inline-confirm.js';
import type { Favorite } from '../lib/types.js';
import type { PopupSession } from './popup-types.js';
import { getSessionHue, profileSwatchCss } from './popup-types.js';
import type { Localizer } from '../lib/localization.js';

// One row across the whole favorites list can be in confirm mode at a time.
// Independent of the profile list's own confirm controller (popup-delete-handler.ts) —
// different list, so the two coexisting briefly is fine, not a bug.
const confirmController = createInlineConfirmController();

const REMOVE_ICON = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Flip a row to the missing-profile state without dropping the saved URL. */
function markMissing(row: HTMLElement, launch: HTMLButtonElement, text: HTMLElement, label: string): void {
  row.classList.add('missing');
  launch.disabled = true;
  if (!text.querySelector('.v2-fav-missing')) {
    const note = document.createElement('span');
    note.className = 'v2-fav-missing';
    note.textContent = label;
    text.appendChild(note);
  }
}

function buildRow(favorite: Favorite, profiles: PopupSession[], localizer: Localizer): HTMLElement {
  const text = (key: string, fallback: string): string => localizer.getMessage(key) || fallback;
  const index = profiles.findIndex(p => p.id === favorite.sessionId);
  const profile = index === -1 ? null : profiles[index];
  const host = hostnameOf(favorite.url);

  const row = document.createElement('div');
  row.className = 'v2-fav-row';

  const launch = document.createElement('button');
  launch.type = 'button';
  launch.className = 'v2-fav-launch';
  launch.setAttribute('data-action', 'launch-favorite');
  launch.setAttribute('aria-label',
    localizer.getMessage('launchFavoriteAriaLabel', [favorite.label]) || `Open favorite ${favorite.label}`);
  launch.title = `${favorite.label} — ${host}`;

  const dot = document.createElement('span');
  dot.className = 'v2-fav-dot';
  if (profile) dot.style.background = profileSwatchCss(getSessionHue(profile, index));

  const body = document.createElement('span');
  body.className = 'v2-fav-text';

  const label = document.createElement('span');
  label.className = 'v2-fav-label';
  // User-editable and defaulted from the page title, which is attacker-supplied:
  // textContent only, never innerHTML. `dir="auto"` isolates its direction.
  label.dir = 'auto';
  label.textContent = favorite.label;

  const hostEl = document.createElement('span');
  hostEl.className = 'v2-fav-host';
  // Forced LTR so a domain cannot be visually reversed in an RTL locale.
  hostEl.dir = 'ltr';
  hostEl.textContent = host;

  body.append(label, hostEl);
  launch.append(dot, body);

  const missingLabel = text('favoriteMissingProfile', 'Profile no longer exists');
  if (!profile) markMissing(row, launch, body, missingLabel);

  launch.addEventListener('click', async () => {
    launch.disabled = true;
    const response = await chrome.runtime.sendMessage({
      action: 'createSessionTab',
      payload: { url: favorite.url, sessionId: favorite.sessionId },
    }) as { error?: string } | null;
    if (response?.error) {
      // The profile vanished between render and click (deleted in another
      // window, or storage edited out of band). Show it here rather than
      // closing the popup over a silent failure.
      markMissing(row, launch, body, missingLabel);
      return;
    }
    window.close();
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'v2-fav-remove';
  remove.setAttribute('data-action', 'remove-favorite');
  remove.title = text('removeFavoriteTitle', 'Remove favorite');
  remove.setAttribute('aria-label',
    localizer.getMessage('removeFavoriteAriaLabel', [favorite.label]) || `Remove favorite ${favorite.label}`);
  remove.innerHTML = REMOVE_ICON;
  remove.addEventListener('click', (e) => {
    e.stopPropagation();
    // Same interaction and the same CSS classes as the profile card's delete
    // confirm — cancel/confirm swap in place, Escape backs out.
    confirmController.start({
      container: row,
      hiddenElements: [launch, remove],
      cancelClassName: 'v2-card-del-cancel',
      confirmClassName: 'v2-card-del-confirm',
      labels: {
        cancelText: text('cancelButton', 'Cancel'),
        cancelTitle: text('cancelDeleteTitle', 'Cancel delete'),
        confirmText: text('deleteTitle', 'Delete'),
        confirmTitle: text('confirmDeleteTitle', 'Confirm delete'),
      },
      onConfirm: async () => {
        await deleteFavorite(favorite.id);
        document.dispatchEvent(new CustomEvent('favoritesChanged'));
      },
    });
  });

  row.append(launch, remove);
  return row;
}

/**
 * Render the favorites section. Hidden entirely when nothing matches, so a user
 * who never saves a favorite sees the popup exactly as it was before.
 */
export async function renderFavoritesList(
  container: HTMLElement,
  profiles: PopupSession[],
  localizer: Localizer,
  query = '',
  /** Returns false if a newer render started while this one awaited storage. */
  isCurrent: () => boolean = () => true,
): Promise<void> {
  // A re-render (search keystroke, favoritesChanged) is about to replace this
  // list's DOM; an open confirm on it would otherwise leak a dangling
  // document keydown listener pointed at detached nodes.
  confirmController.cancelActive();
  const favorites = await getFavorites();
  // Bail before touching the DOM so a slow earlier read cannot repaint over a
  // newer one (type into search, then clear it inside the debounce window).
  if (!isCurrent()) return;
  const q = query.toLowerCase().trim();
  const filtered = q
    ? favorites.filter(f =>
        f.label.toLowerCase().includes(q) || hostnameOf(f.url).toLowerCase().includes(q))
    : favorites;

  container.replaceChildren();
  container.classList.toggle('hidden', filtered.length === 0);
  if (filtered.length === 0) return;

  const head = document.createElement('div');
  head.className = 'v2-fav-head';
  const headLabel = document.createElement('span');
  headLabel.textContent = localizer.getMessage('favoritesSectionTitle') || 'Favorites';
  const count = document.createElement('span');
  count.className = 'v2-list-count';
  count.textContent = String(filtered.length);
  head.append(headLabel, count);

  const list = document.createElement('div');
  list.className = 'v2-fav-list';
  for (const favorite of filtered) list.appendChild(buildRow(favorite, profiles, localizer));

  container.append(head, list);
}
