import type { ProfileSite } from './types.js'

export const UNASSIGNED_SITE_KEY = 'unassigned'

export function profileSiteFromUrl(url: string, name?: string): ProfileSite | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return {
    name: name?.trim() || parsed.hostname,
    origin: parsed.origin,
    url: parsed.href,
  }
}

export function profileSiteKey(site: ProfileSite | undefined): string {
  return site?.origin || UNASSIGNED_SITE_KEY
}
