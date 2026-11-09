import { parseJsonObject } from '../../scripts/release-version.js'

export function parseCookieResponse(body: string | null): { cookies: Record<string, string> } {
  if (body === null) throw new Error('Cookie response body is missing')
  const data = parseJsonObject(body, 'Cookie response')
  const cookies = data.cookies
  if (typeof cookies !== 'object' || cookies === null || Array.isArray(cookies) ||
      !Object.values(cookies).every(value => typeof value === 'string')) {
    throw new Error('Cookie response must contain a string cookie map')
  }
  return { cookies: cookies as Record<string, string> }
}
