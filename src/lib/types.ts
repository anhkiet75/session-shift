// Shared TypeScript interfaces for SessionShift.
// Single source of truth for cross-module data shapes.

export interface Session {
  id: string
  name: string
  hue?: number
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
  | {
      action: 'updateCookie'
      payload: {
        /** Legacy attribute-less `name=value` set path. Prefer `setCookieStr`. */
        cookieStr?: string
        /** Full cookie string (document.cookie / cookieStore.set); carries Path/Max-Age/Expires. */
        setCookieStr?: string
        /** document.cookie deletions (max-age<=0), matched by name at the document scope. */
        deletedNames?: string[]
        /** cookieStore.delete structured targets — matched by name/domain/path, not document URL. */
        deleteTargets?: { name: string; domain?: string; path?: string }[]
        url?: string
      }
    }
  | { action: 'refreshBadge'; payload: { tabId: number } }
  | { action: 'deleteSession'; payload: { sessionId: string } }
  | { action: 'createSessionTab'; payload: { url: string; sessionId: string } }
  | { action: 'duplicateSession'; payload?: { sessionId: string } }
  | { action: 'colorSession'; payload: { sessionId: string; hue: number } }

export type DNRRule = chrome.declarativeNetRequest.Rule
