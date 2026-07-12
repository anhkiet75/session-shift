// popup-theme.ts — Theme cycle, apply, and toggle logic for the popup.

import type { Theme } from '../lib/types.js';
import { mutateExtSettingsField } from '../lib/settings-store.js';

export const THEME_CYCLE: Theme[] = ['light', 'dark', 'system'];

export const THEME_ICONS: Record<Theme, string> = {
  light: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  dark:  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  system:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25"/></svg>',
};

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

export function applyTheme(theme: Theme): void {
  if (systemThemeListener) {
    darkMedia.removeEventListener('change', systemThemeListener);
    systemThemeListener = null;
  }

  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
    document.documentElement.classList.toggle('dark', darkMedia.matches);
    systemThemeListener = (e) => document.documentElement.classList.toggle('dark', e.matches);
    darkMedia.addEventListener('change', systemThemeListener);
  } else {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }
}

export function updateThemeToggle(theme: Theme): void {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  btn.innerHTML = THEME_ICONS[theme];
  const label = `Theme: ${theme} (click to change)`;
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

async function readSettings(): Promise<Record<string, unknown>> {
  const result = await chrome.storage.local.get(['ext_settings']);
  return (result.ext_settings as Record<string, unknown>) || {};
}

export async function applyStoredTheme(): Promise<void> {
  const settings = await readSettings();
  const theme = (settings.theme as Theme | undefined) || 'system';
  applyTheme(theme);
  updateThemeToggle(theme);
}

let cyclingTheme = false;

export async function cycleTheme(): Promise<void> {
  if (cyclingTheme) return;
  cyclingTheme = true;
  try {
    const settings = await readSettings();
    const current = (settings.theme as Theme | undefined) || 'system';
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
    await mutateExtSettingsField('theme', next);
    applyTheme(next);
    updateThemeToggle(next);
  } finally {
    cyclingTheme = false;
  }
}
