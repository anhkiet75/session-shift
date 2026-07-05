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
