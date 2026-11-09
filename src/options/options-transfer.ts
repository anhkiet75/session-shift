import { buildProfileTransferPayload, importProfileTransfer, parseProfileTransfer, profileTransferJson } from '../lib/profile-transfer.js'
import type { Localizer } from '../lib/localization.js'

// A hand-picked local file is still untrusted input. This cap is far above a
// real export (5000 profiles with full cookie jars) but keeps a stray archive
// or disk image from being read into memory as JSON.
const MAX_TRANSFER_FILE_BYTES = 32 * 1024 * 1024

function isJsonFile(file: File): boolean {
  const hasJsonExtension = /\.json$/i.test(file.name)
  const hasJsonType = file.type === 'application/json'
  // Browsers commonly leave `type` empty for locally selected files, so accept
  // a .json extension on its own. Reject a file that declares a different type.
  if (file.type && !hasJsonType && !hasJsonExtension) return false
  return hasJsonExtension || hasJsonType
}

export function initTransferPanel(localizer: Localizer): void {
  const exportButton = document.getElementById('exportProfilesBtn') as HTMLButtonElement
  const importButton = document.getElementById('importProfilesBtn') as HTMLButtonElement
  const fileInput = document.getElementById('importProfilesFile') as HTMLInputElement
  const status = document.getElementById('transferStatus') as HTMLElement
  const message = (key: string, fallback: string): string => localizer.getMessage(key) || fallback

  exportButton.addEventListener('click', async () => {
    exportButton.disabled = true
    try {
      const payload = await buildProfileTransferPayload()
      const blob = new Blob([profileTransferJson(payload)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'sessionshift-profiles-' + new Date().toISOString().slice(0, 10) + '.json'
      link.hidden = true
      document.body.appendChild(link)
      link.click()
      link.remove()
      // Revoke after the browser has had a turn to start reading the blob.
      setTimeout(() => URL.revokeObjectURL(url), 0)
      status.textContent = message('exportProfilesSuccess', 'Profiles exported.')
    } catch (error) {
      console.error('[SessionShift] Failed to export profiles', error)
      status.textContent = message('transferFailed', 'The transfer could not be completed.')
    } finally {
      exportButton.disabled = false
    }
  })

  importButton.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) return
    if (file.size > MAX_TRANSFER_FILE_BYTES) {
      status.textContent = message('transferFileTooLarge', 'This export file is too large to import.')
      return
    }
    if (!isJsonFile(file)) {
      status.textContent = message('unsupportedTransferFile', 'This is not a supported SessionShift export.')
      return
    }

    importButton.disabled = true
    try {
      const payload = parseProfileTransfer(await file.text())
      const result = await importProfileTransfer(payload)
      status.textContent = localizer.getMessage('importProfilesSuccess', [String(result.importedProfiles)])
        || 'Imported profiles: ' + result.importedProfiles + '.'
    } catch (error) {
      console.error('[SessionShift] Failed to import profiles', error)
      const code = error instanceof Error ? error.message : 'transferFailed'
      const key = code === 'invalid-json'
        ? 'invalidTransferJson'
        : code === 'unsupported-file'
          ? 'unsupportedTransferFile'
          : 'invalidTransferFile'
      status.textContent = message(key, 'The selected file is not a valid SessionShift export.')
    } finally {
      importButton.disabled = false
    }
  })
}

