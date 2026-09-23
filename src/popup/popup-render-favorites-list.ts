// popup-render-favorites-list.ts — Favorites section. One click launches a
// saved (url, profile) pair into a new tab carrying that profile's cookies.
//
// Launch reuses the existing `createSessionTab` message verbatim — the same
// path the context menu and the profile right-click menu already use — so this
// section adds no new cookie-isolation surface.

import { getFavorites, deleteFavorite, updateFavorite, MAX_LABEL_LENGTH } from '../lib/favorites-store.js';
import { createInlineConfirmController } from '../lib/inline-confirm.js';
import type { Favorite } from '../lib/types.js';
import type { PopupSession } from './popup-types.js';
import { getSessionHue, profileSwatchCss } from './popup-types.js';
import type { Localizer } from '../lib/localization.js';
import { RENAME_ICON, CONFIRM_ICON } from './popup-rename-handler.js';

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

/**
 * Swap the launch button for an inline label input. Enter, blur, or the rename
 * button (shown as a check while editing) saves; Escape backs out. Every exit
 * restores the row in place (pencil back, × back), so the row never depends on
 * a later list re-render to leave edit mode.
 */
function startFavoriteRename(
  row: HTMLElement,
  favorite: Favorite,
  launch: HTMLElement,
  labelEl: HTMLElement,
  dot: HTMLElement,
  rename: HTMLButtonElement,
  hiddenElements: HTMLElement[],
): void {
  const existing = row.querySelector<HTMLInputElement>('.v2-rename-input');
  if (existing) { existing.blur(); return; }
  confirmController.cancelActive();

  const edit = document.createElement('span');
  edit.className = 'v2-fav-edit';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'v2-rename-input';
  input.dir = 'auto'; // user-supplied label: isolate its own direction while typing
  input.value = favorite.label;
  input.maxLength = MAX_LABEL_LENGTH;
  edit.append(dot.cloneNode(), input);

  launch.style.display = 'none';
  hiddenElements.forEach(el => { el.style.display = 'none'; });
  launch.after(edit);
  rename.innerHTML = CONFIRM_ICON;
  rename.classList.add('editing');
  // Keep focus in the input on press so the click is the one that saves
  // (otherwise blur saves first and the click would reopen the editor).
  const keepFocus = (e: MouseEvent): void => { e.preventDefault(); };
  rename.addEventListener('mousedown', keepFocus);
  input.focus();
  input.select();

  let done = false;
  function restore(): void {
    edit.remove();
    rename.innerHTML = RENAME_ICON;
    rename.classList.remove('editing');
    rename.removeEventListener('mousedown', keepFocus);
    launch.style.display = '';
    hiddenElements.forEach(el => { el.style.display = ''; });
  }

  async function commit(): Promise<void> {
    if (done) return;
    done = true;
    input.disabled = true;
    if (input.value === favorite.label) { restore(); return; }
    const result = await updateFavorite(favorite.id, { label: input.value }).catch(() => null);
    if (result?.status === 'updated') {
      favorite.label = result.favorite.label; // blank falls back to the hostname
      labelEl.textContent = favorite.label;
    }
    restore();
    if (result?.status === 'updated') document.dispatchEvent(new CustomEvent('favoritesChanged'));
  }

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') {
      // Keep Escape from also closing the popup.
      e.preventDefault();
      done = true;
      restore();
    }
  });
  input.addEventListener('blur', () => commit());
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
    // The row stays visible while its delete confirm is open; don't launch then.
    if (row.querySelector('.v2-card-del-confirm')) return;
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

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'v2-fav-rename';
  rename.setAttribute('data-action', 'rename-favorite');
  rename.title = text('renameTitle', 'Rename');
  rename.setAttribute('aria-label', `${text('renameTitle', 'Rename')} ${favorite.label}`);
  rename.innerHTML = RENAME_ICON;

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
    // confirm — the label stays, only the × swaps for cancel/confirm, Escape
    // backs out.
    confirmController.start({
      container: row,
      hiddenElements: [rename, remove],
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

  rename.addEventListener('click', (e) => {
    e.stopPropagation();
    startFavoriteRename(row, favorite, launch, label, dot, rename, [remove]);
  });

  row.append(launch, rename, remove);
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
