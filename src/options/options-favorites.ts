// options-favorites.ts — Favorites tab: full CRUD + reorder for saved
// (url, profile) launchers. The popup is only a launcher; all editing lives
// here, where there is room for a multi-field record.
//
// Holds no authoritative state — every mutation goes through
// `lib/favorites-store.ts` and this panel re-reads afterwards, so a favorite
// saved from the popup while this page is open shows up on the next render.

import { MAX_FAVORITES, getFavorites } from '../lib/favorites-store.js'
import { getProfiles } from '../lib/session-store.js'
import type { Localizer } from '../lib/localization.js'
import { buildFavoriteRow, cancelActiveFavoriteRowConfirm } from './options-favorites-row.js'
import type { PanelContext } from './options-favorites-types.js'

function buildEmptyState(ctx: PanelContext): HTMLElement {
  const empty = document.createElement('div')
  empty.className = 'opt-fav-empty'
  const title = document.createElement('div')
  title.className = 'opt-fav-empty-title'
  title.textContent = ctx.text('favoritesEmptyTitle', 'No favorites yet')
  const sub = document.createElement('div')
  sub.className = 'opt-fav-empty-sub'
  sub.textContent = ctx.text(
    'favoritesEmptySub',
    'Open a page in a profile, then click the star in the SessionShift popup to save it here.',
  )
  empty.append(title, sub)
  return empty
}

export async function initFavoritesPanel(localizer: Localizer): Promise<void> {
  const body = document.getElementById('favoritesPanelBody')
  const status = document.getElementById('favoritesStatus')
  if (!body || !status) return

  const ctx: PanelContext = {
    profiles: [],
    localizer,
    text: (key, fallback) => localizer.getMessage(key) || fallback,
    named: (key, name, fallback) => localizer.getMessage(key, [name]) || fallback,
    announce: (message) => { status.textContent = message },
    refresh: async (favId, action) => {
      await render()
      if (!favId || !action) return
      // Favorite ids come from crypto.randomUUID, never from user input, so
      // they are safe to interpolate into an attribute selector.
      const target = body.querySelector<HTMLElement>(`[data-fav-id="${favId}"][data-fav-action="${action}"]`)
      if (target && !target.matches(':disabled')) {
        target.focus()
        return
      }
      // A move that lands at a bound disables the button just pressed. Fall back
      // to the OPPOSITE move button — never to a generic match, which in DOM
      // order is the profile <select>, where one arrow key would silently
      // re-bind the favorite to another profile.
      const opposite = action === 'up' ? 'down' : action === 'down' ? 'up' : null
      if (!opposite) return
      const fallback = body.querySelector<HTMLElement>(`[data-fav-id="${favId}"][data-fav-action="${opposite}"]`)
      if (fallback && !fallback.matches(':disabled')) fallback.focus()
    },
  }

  async function render(): Promise<void> {
    const [favorites, profiles] = await Promise.all([getFavorites(), getProfiles()])
    ctx.profiles = profiles
    // Any open row confirm is about to be wiped out from under itself.
    cancelActiveFavoriteRowConfirm()
    body!.replaceChildren()

    if (favorites.length === 0) {
      body!.appendChild(buildEmptyState(ctx))
      return
    }

    const list = document.createElement('div')
    list.className = 'opt-fav-list'
    favorites.forEach((favorite, index) => {
      list.appendChild(buildFavoriteRow(favorite, index, favorites.length, ctx))
    })
    body!.appendChild(list)

    if (favorites.length >= MAX_FAVORITES) {
      const cap = document.createElement('p')
      cap.className = 'opt-fav-cap'
      cap.textContent = ctx.text('favoritesLimitReached', 'Favorite limit reached.')
      body!.appendChild(cap)
    }
  }

  await render()
}
