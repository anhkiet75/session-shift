import type { CookieStore, CookieStoreEntry } from './session-store.js'
import { getCookieStore, getProfiles } from './session-store.js'
import type { ProfileSite, Session } from './types.js'
import { isValidCookieName, isValidCookieValue } from './cookie-parser.js'

export const PROFILE_TRANSFER_FORMAT = 'sessionshift-profile-export'
export const PROFILE_TRANSFER_VERSION = 1

export interface ProfileTransferPayload {
  format: typeof PROFILE_TRANSFER_FORMAT
  version: typeof PROFILE_TRANSFER_VERSION
  exportedAt: string
  profiles: Session[]
  cookies: Record<string, CookieStore>
}

export interface ProfileImportResult {
  importedProfiles: number
  importedCookieStores: number
}

const MAX_TRANSFER_PROFILES = 5000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHttpOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === origin
  } catch {
    return false
  }
}

function validSite(value: unknown): value is ProfileSite {
  if (!isRecord(value)
    || typeof value.name !== 'string'
    || value.name.trim().length === 0
    || typeof value.origin !== 'string'
    || typeof value.url !== 'string') {
    return false
  }
  if (!isHttpOrigin(value.origin)) return false
  try {
    const url = new URL(value.url)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value.origin
  } catch {
    return false
  }
}

/** Split a `name|domain|path` store key, keeping any `|` inside the path. */
function cookieKeyParts(key: string): { name: string; domain?: string; path?: string } | null {
  const first = key.indexOf('|')
  if (first === -1) return { name: key }
  const second = key.indexOf('|', first + 1)
  if (second === -1) return null
  return {
    name: key.slice(0, first),
    domain: key.slice(first + 1, second),
    path: key.slice(second + 1),
  }
}

// Cookie entries cross an untrusted boundary here. The name and value are
// splices into a DNR `Cookie:` header, so they get the same authoritative
// checks the capture paths use. A domain is mandatory: without one
// `cookieMatchesRequest` treats the cookie as scoped to every host.
function validCookieEntry(key: string, value: unknown): value is CookieStoreEntry {
  if (!isRecord(value)
    || typeof value.value !== 'string'
    || !isValidCookieValue(value.value)
    || !(value.expires === undefined || value.expires === null
      || (typeof value.expires === 'number' && Number.isFinite(value.expires)))
    || !(value.secure === undefined || typeof value.secure === 'boolean')
    || !(value.httpOnly === undefined || typeof value.httpOnly === 'boolean')
    || !(value.name === undefined || typeof value.name === 'string')
    || !(value.domain === undefined || typeof value.domain === 'string')
    || !(value.path === undefined || typeof value.path === 'string')) {
    return false
  }
  const parts = cookieKeyParts(key)
  if (!parts) return false
  const name = value.name ?? parts.name
  const domain = value.domain ?? parts.domain
  const path = value.path ?? parts.path
  return isValidCookieName(name)
    && typeof domain === 'string'
    && domain.length > 0
    && typeof path === 'string'
    && path.startsWith('/')
}

function validCookieStore(value: unknown): value is CookieStore {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([key, entry]) => key.length > 0 && validCookieEntry(key, entry))
}

function validSession(value: unknown): value is Session {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || value.id.trim().length === 0
    || value.id.length > 200
    || typeof value.name !== 'string') {
    return false
  }
  if (value.hue !== undefined
    && (typeof value.hue !== 'number' || !Number.isFinite(value.hue) || value.hue < 0 || value.hue > 360)) {
    return false
  }
  return value.site === undefined || validSite(value.site)
}

function validExportedAt(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
}

export function parseProfileTransfer(text: string): ProfileTransferPayload {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error('invalid-json')
  }
  if (!isRecord(value)
    || value.format !== PROFILE_TRANSFER_FORMAT
    || value.version !== PROFILE_TRANSFER_VERSION
    || !validExportedAt(value.exportedAt)
    || !Array.isArray(value.profiles)
    || value.profiles.length > MAX_TRANSFER_PROFILES
    || !isRecord(value.cookies)) {
    throw new Error('unsupported-file')
  }
  if (!value.profiles.every(validSession)) throw new Error('invalid-profile')

  const ids = new Set<string>()
  for (const profile of value.profiles) {
    if (ids.has(profile.id)) throw new Error('duplicate-profile')
    ids.add(profile.id)
  }
  for (const [id, store] of Object.entries(value.cookies)) {
    if (!id || !ids.has(id) || !validCookieStore(store)) throw new Error('invalid-cookies')
  }
  return value as unknown as ProfileTransferPayload
}

export async function buildProfileTransferPayload(): Promise<ProfileTransferPayload> {
  const profiles = await getProfiles()
  const cookies: Record<string, CookieStore> = {}
  for (const profile of profiles) {
    const store = await getCookieStore(profile.id)
    // Drop entries the importer would reject, so an export from this build is
    // always importable. Name-only legacy keys have no domain to scope them to.
    const safe: CookieStore = {}
    for (const [key, entry] of Object.entries(store)) {
      if (validCookieEntry(key, entry)) safe[key] = entry
    }
    cookies[profile.id] = safe
  }
  return {
    format: PROFILE_TRANSFER_FORMAT,
    version: PROFILE_TRANSFER_VERSION,
    exportedAt: new Date().toISOString(),
    profiles,
    cookies,
  }
}

export function profileTransferJson(payload: ProfileTransferPayload): string {
  return JSON.stringify(payload, null, 2)
}

function nextImportedName(base: string, used: Set<string>): string {
  let name = base + ' (imported)'
  let index = 2
  while (used.has(name)) name = base + ' (imported ' + index++ + ')'
  return name
}

export async function importProfileTransfer(payload: ProfileTransferPayload): Promise<ProfileImportResult> {
  const existing = await getProfiles()
  const usedIds = new Set(existing.map(profile => profile.id))
  const usedNames = new Set(existing.map(profile => profile.name))
  const existingCookieKeys = await chrome.storage.local.get(
    payload.profiles.map(profile => 'cookies_' + profile.id),
  )
  const imported: Session[] = []
  const cookieWrites: Array<{ id: string; store: CookieStore }> = []

  const idIsAvailable = (id: string): boolean =>
    !usedIds.has(id) && !(('cookies_' + id) in existingCookieKeys)

  for (const source of payload.profiles) {
    // An occupied id belongs to local data, including orphaned cookie stores.
    if (!idIsAvailable(source.id)) continue
    const id = source.id
    const name = usedNames.has(source.name) ? nextImportedName(source.name, usedNames) : source.name
    imported.push({ ...source, id, name })
    usedIds.add(id)
    usedNames.add(name)
    cookieWrites.push({ id, store: payload.cookies[source.id] ?? {} })
  }

  if (imported.length > 0) {
    const writes: Record<string, unknown> = { profiles: [...existing, ...imported] }
    for (const write of cookieWrites) writes['cookies_' + write.id] = write.store
    await chrome.storage.local.set(writes)
  }

  return {
    importedProfiles: imported.length,
    importedCookieStores: cookieWrites.filter(write => Object.keys(write.store).length > 0).length,
  }
}
