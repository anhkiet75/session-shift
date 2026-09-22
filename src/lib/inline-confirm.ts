// inline-confirm.ts — Generic inline "are you sure" swap for a row/card that
// wants a confirm step before a destructive action, without a modal.
//
// Extracted so more than one surface can share it: `popup-delete-handler.ts`
// owns the original for profile cards; the favorites lists (popup + Options)
// use this directly, reusing the same interaction — one row in confirm mode
// at a time, Escape cancels, a failed confirm re-arms rather than vanishing.

export interface InlineConfirmLabels {
  cancelText: string
  cancelTitle: string
  confirmText: string
  confirmTitle: string
}

export interface InlineConfirmOptions {
  /** Appended with the cancel/confirm buttons. */
  container: HTMLElement
  /** Hidden (display:none) while the row is in confirm mode, restored on cancel. */
  hiddenElements: HTMLElement[]
  cancelClassName: string
  confirmClassName: string
  labels: InlineConfirmLabels
  onConfirm: () => Promise<void>
}

export interface InlineConfirmController {
  start(options: InlineConfirmOptions): void
  /** Cancels whichever row this controller has open, if any. Safe to call idly. */
  cancelActive(): void
}

/**
 * A controller instance tracks "at most one open confirm" for its own set of
 * rows. Callers that render more than one list from the same module (the
 * profile list, the favorites list) get independent controllers, so a
 * favorite confirm and a profile confirm can coexist — they are different
 * lists, not different rows of the same list.
 */
export function createInlineConfirmController(): InlineConfirmController {
  let activeCancel: (() => void) | null = null

  function cancelActive(): void {
    if (activeCancel) { activeCancel(); activeCancel = null }
  }

  function start(options: InlineConfirmOptions): void {
    cancelActive()
    const { container, hiddenElements, cancelClassName, confirmClassName, labels, onConfirm } = options

    hiddenElements.forEach(el => { el.style.display = 'none' })

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = cancelClassName
    cancelBtn.textContent = labels.cancelText
    cancelBtn.title = labels.cancelTitle

    const confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.className = confirmClassName
    confirmBtn.textContent = labels.confirmText
    confirmBtn.title = labels.confirmTitle

    function cancel(): void {
      cancelBtn.remove()
      confirmBtn.remove()
      hiddenElements.forEach(el => { el.style.display = '' })
      document.removeEventListener('keydown', onKey)
      if (activeCancel === cancel) activeCancel = null
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') cancel()
    }

    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); cancel() })

    confirmBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      confirmBtn.disabled = true
      cancelBtn.disabled = true
      document.removeEventListener('keydown', onKey)
      activeCancel = null
      try {
        await onConfirm()
      } catch {
        // Re-arm rather than leaving the row in a dead confirmed-but-failed state.
        confirmBtn.disabled = false
        cancelBtn.disabled = false
        document.addEventListener('keydown', onKey)
        activeCancel = cancel
      }
    })

    document.addEventListener('keydown', onKey)
    activeCancel = cancel

    container.appendChild(cancelBtn)
    container.appendChild(confirmBtn)
    cancelBtn.focus()
  }

  return { start, cancelActive }
}
