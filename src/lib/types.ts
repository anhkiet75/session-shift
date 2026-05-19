// Shared TypeScript interfaces for SessionShift.
// Single source of truth for cross-module data shapes.

export interface Session {
  id: string
  name: string
  hue?: number
  origin?: string
}

export type Theme = 'dark' | 'light' | 'system'

export interface ExtSettings {
  theme: Theme
}

export interface ParsedCookie {
  name: string
  value: string
  domain: string | null
  path: string | null
  expires: number | null
  secure: boolean
  httpOnly: boolean
  sameSite: string | null
}

export type BackgroundMessage =
  | { action: 'setSession'; payload: { tabId: number; sessionId: string } }
  | { action: 'getSession'; payload?: { tabId?: number } }
  | { action: 'getSessionForBootstrap'; payload?: { tabId?: number } }
  | { action: 'updateCookie'; payload: { cookieStr: string; deletedNames?: string[] } }
  | { action: 'refreshBadge'; payload: { tabId: number } }
  | { action: 'deleteSession'; payload: { sessionId: string } }
  | { action: 'createSessionTab'; payload: { url: string; sessionId: string } }
  | { action: 'duplicateSession'; payload?: { sessionId: string; origin: string } }
  | { action: 'colorSession'; payload: { sessionId: string; hue: number } }

export type DNRRule = chrome.declarativeNetRequest.Rule
