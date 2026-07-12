// settings-store.ts — Shared ExtSettings read/write, usable from options page and service worker.

import type { ExtSettings } from './types.js'

const SETTINGS_KEY = 'ext_settings'

export async function getExtSettings(): Promise<ExtSettings> {
  const result = await chrome.storage.local.get([SETTINGS_KEY])
  return (result[SETTINGS_KEY] as ExtSettings) || { theme: 'system' }
}

export async function setExtSettings(settings: ExtSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
}

// Per-context serialization only (each extension page/service-worker instance
// has its own queue) — chained so concurrent same-context field writes
// (theme, language, inheritance) read-modify-write one at a time instead of
// racing on a stale snapshot. Chrome storage itself has no read-modify-write
// primitive.
let mutationQueue: Promise<unknown> = Promise.resolve()

export function mutateExtSettingsField<K extends keyof ExtSettings>(
  field: K,
  value: ExtSettings[K]
): Promise<void> {
  const task = mutationQueue.then(async () => {
    const current = await getExtSettings()
    await setExtSettings({ ...current, [field]: value })
  })
  mutationQueue = task.catch(() => {})
  return task
}
