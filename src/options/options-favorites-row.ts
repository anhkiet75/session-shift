// options-favorites-row.ts — One editable favorite row: label, URL, bound
// profile, reorder and delete.
//
// Committed field edits repaint only their own control rather than re-rendering
// the panel, so tabbing out of an input does not yank focus away from wherever
// it just landed. Structural changes (reorder, delete, rebind) do re-render,
// and restore focus through `ctx.refresh`.

import { updateFavorite, deleteFavorite, moveFavorite } from '../lib/favorites-store.js'
import { resolveProfileHue, profileSwatchCss } from '../lib/profile-color.js'
import { createInlineConfirmController } from '../lib/inline-confirm.js'
import type { Favorite } from '../lib/types.js'
import { MISSING_PROFILE_VALUE } from './options-favorites-types.js'
import type { PanelContext } from './options-favorites-types.js'

// One row across the whole panel can be in confirm mode at a time. The panel
// re-renders wholesale on every mutation (options-favorites.ts's `render()`),
// so the panel must cancel this before it wipes the DOM out from under an
// open confirm — see cancelActiveFavoriteRowConfirm below.
const confirmController = createInlineConfirmController()

/** Called by options-favorites.ts right before it rebuilds the row list. */
export function cancelActiveFavoriteRowConfirm(): void {
  confirmController.cancelActive()
}

const ICON_UP = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ICON_DOWN = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ICON_DELETE = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

function iconButton(className: string, icon: string, favId: string, action: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.innerHTML = icon // static markup — no favorite data is ever interpolated
  button.dataset.favId = favId
  button.dataset.favAction = action
  return button
}

function textField(className: string, direction: 'auto' | 'ltr', value: string, ariaLabel: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = className
  input.dir = direction
  input.value = value
  input.setAttribute('aria-label', ariaLabel)
  return input
}

function buildProfileSelect(favorite: Favorite, ctx: PanelContext): HTMLSelectElement {
  const select = document.createElement('select')
  select.className = 'opt-fav-select'
  select.setAttribute('aria-label', ctx.text('favoriteProfileColumn', 'Profile'))
  select.dataset.favId = favorite.id
  select.dataset.favAction = 'profile'

  const bound = ctx.profiles.some(p => p.id === favorite.sessionId)
  if (!bound) {
    // Unresolved rather than silently rebound or dropped: the URL is worth
    // keeping, and only the user can say which profile should own it now.
    const missing = document.createElement('option')
    missing.value = MISSING_PROFILE_VALUE
    missing.textContent = ctx.text('favoriteMissingProfile', 'Profile no longer exists')
    select.appendChild(missing)
  }
  for (const profile of ctx.profiles) {
    const option = document.createElement('option')
    option.value = profile.id
    option.textContent = profile.name || profile.id
    select.appendChild(option)
  }
  select.value = bound ? favorite.sessionId : MISSING_PROFILE_VALUE
  return select
}

export function buildFavoriteRow(
  favorite: Favorite,
  index: number,
  total: number,
  ctx: PanelContext,
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'opt-fav-row'
  const profileIndex = ctx.profiles.findIndex(p => p.id === favorite.sessionId)
  if (profileIndex === -1) row.classList.add('missing')

  const dot = document.createElement('span')
  dot.className = 'opt-fav-dot'
  if (profileIndex !== -1) {
    dot.style.background = profileSwatchCss(resolveProfileHue(ctx.profiles[profileIndex], profileIndex))
  }

  // `dir="auto"` isolates the user-supplied label; the URL is pinned LTR so a
  // domain can never be visually reversed in an RTL locale.
  const label = textField('opt-fav-input', 'auto', favorite.label, ctx.text('favoriteLabelColumn', 'Label'))
  const url = textField('opt-fav-input opt-fav-url', 'ltr', favorite.url, ctx.text('favoriteUrlColumn', 'URL'))

  const error = document.createElement('span')
  error.className = 'opt-fav-error hidden'
  error.setAttribute('role', 'alert')

  const fields = document.createElement('div')
  fields.className = 'opt-fav-fields'
  fields.append(label, url, error)

  const select = buildProfileSelect(favorite, ctx)
  const up = iconButton('opt-fav-btn', ICON_UP, favorite.id, 'up')
  const down = iconButton('opt-fav-btn', ICON_DOWN, favorite.id, 'down')
  const remove = iconButton('opt-fav-btn opt-fav-del', ICON_DELETE, favorite.id, 'delete')
  up.disabled = index === 0
  down.disabled = index === total - 1

  function applyActionLabels(): void {
    up.setAttribute('aria-label', ctx.named('favoriteMoveUpAriaLabel', favorite.label, `Move ${favorite.label} up`))
    down.setAttribute('aria-label', ctx.named('favoriteMoveDownAriaLabel', favorite.label, `Move ${favorite.label} down`))
    remove.setAttribute('aria-label', ctx.named('favoriteDeleteAriaLabel', favorite.label, `Delete ${favorite.label}`))
  }
  applyActionLabels()

  label.addEventListener('blur', async () => {
    if (label.value === favorite.label) return
    const result = await updateFavorite(favorite.id, { label: label.value })
    if (result.status !== 'updated') return
    favorite.label = result.favorite.label
    label.value = result.favorite.label // a blank label falls back to the hostname
    applyActionLabels()
  })

  url.addEventListener('blur', async () => {
    if (url.value === favorite.url) return
    const result = await updateFavorite(favorite.id, { url: url.value })
    if (result.status === 'invalid-url') {
      error.textContent = ctx.text('favoriteInvalidUrl', 'Enter a valid http:// or https:// address.')
      error.classList.remove('hidden')
      url.setAttribute('aria-invalid', 'true')
      url.value = favorite.url // revert — storage is unchanged
      return
    }
    error.classList.add('hidden')
    url.removeAttribute('aria-invalid')
    if (result.status !== 'updated') return
    favorite.url = result.favorite.url
    url.value = result.favorite.url
  })

  for (const field of [label, url]) {
    field.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') field.blur() })
  }

  select.addEventListener('change', async () => {
    if (select.value === MISSING_PROFILE_VALUE) return
    const result = await updateFavorite(favorite.id, { sessionId: select.value })
    if (result.status !== 'updated') return
    await ctx.refresh(favorite.id, 'profile') // repaints the swatch, clears the unresolved state
  })

  for (const [button, direction] of [[up, 'up'], [down, 'down']] as const) {
    button.addEventListener('click', async () => {
      if (!await moveFavorite(favorite.id, direction)) return
      ctx.announce(ctx.text('favoritesReorderedAnnouncement', 'Favorites reordered.'))
      await ctx.refresh(favorite.id, direction)
    })
  }

  const actions = document.createElement('div')
  actions.className = 'opt-fav-actions'
  actions.append(up, down, remove)

  remove.addEventListener('click', () => {
    // Same interaction as the popup's favorite rows and the profile cards —
    // cancel/confirm swap in place, Escape backs out — with Options-styled
    // buttons since this page doesn't share popup.css's classes.
    confirmController.start({
      container: actions,
      hiddenElements: [up, down, remove],
      cancelClassName: 'opt-fav-del-cancel',
      confirmClassName: 'opt-fav-del-confirm',
      labels: {
        cancelText: ctx.text('cancelButton', 'Cancel'),
        cancelTitle: ctx.text('cancelDeleteTitle', 'Cancel delete'),
        confirmText: ctx.text('deleteTitle', 'Delete'),
        confirmTitle: ctx.text('confirmDeleteTitle', 'Confirm delete'),
      },
      onConfirm: async () => {
        await deleteFavorite(favorite.id)
        ctx.announce(ctx.named('favoriteRemovedAnnouncement', favorite.label, `${favorite.label} removed.`))
        await ctx.refresh()
      },
    })
  })

  row.append(dot, fields, select, actions)
  return row
}
