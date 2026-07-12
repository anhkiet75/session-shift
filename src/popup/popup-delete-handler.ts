// popup-delete-handler.ts — Inline delete confirm for session cards.

// At most one card can be in confirm mode at a time.
let activeCancel: (() => void) | null = null;

export function cancelActiveConfirm(): void {
  if (activeCancel) { activeCancel(); activeCancel = null; }
}

export function startDeleteConfirm(
  actions: HTMLElement,
  hiddenButtons: HTMLElement[],
  onConfirm: () => Promise<void>
): void {
  if (activeCancel) { activeCancel(); activeCancel = null; }

  hiddenButtons.forEach(b => { b.style.display = 'none'; });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'v2-card-del-cancel';
  cancelBtn.setAttribute('data-action', 'cancel-delete');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.title = 'Cancel delete';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'v2-card-del-confirm';
  confirmBtn.setAttribute('data-action', 'confirm-delete');
  confirmBtn.textContent = 'Delete';
  confirmBtn.title = 'Confirm delete';

  function cancel(): void {
    cancelBtn.remove();
    confirmBtn.remove();
    hiddenButtons.forEach(b => { b.style.display = ''; });
    document.removeEventListener('keydown', onKey);
    if (activeCancel === cancel) activeCancel = null;
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') cancel();
  }

  cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); cancel(); });

  confirmBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    document.removeEventListener('keydown', onKey);
    activeCancel = null;
    try {
      await onConfirm();
    } catch (_err) {
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      document.addEventListener('keydown', onKey);
      activeCancel = cancel;
    }
  });

  document.addEventListener('keydown', onKey);
  activeCancel = cancel;

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  cancelBtn.focus();
}
