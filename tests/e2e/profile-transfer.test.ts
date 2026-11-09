import { parseProfileTransfer } from '../../src/lib/profile-transfer.js'
import { parseJsonObject } from '../../scripts/release-version.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './extension-fixtures'
import type { Page } from '@playwright/test'

type StoredSite = { name: string; origin: string; url: string }
type StoredProfile = { id: string; name: string; hue?: number; site?: StoredSite }
type StoredCookie = { name?: string; value: string; domain?: string; path?: string }

async function readProfiles(page: Page): Promise<StoredProfile[]> {
  return page.evaluate(async () => {
    const { profiles } = await chrome.storage.local.get(['profiles'])
    return (profiles ?? []) as StoredProfile[]
  })
}

async function readCookieStore(page: Page, profileId: string): Promise<Record<string, StoredCookie>> {
  return page.evaluate(async (id) => {
    const data = await chrome.storage.local.get([`cookies_${id}`])
    return (data[`cookies_${id}`] ?? {}) as Record<string, StoredCookie>
  }, profileId)
}

const SITE: StoredSite = {
  name: 'Example Mail',
  origin: 'https://mail.example.test',
  url: 'https://mail.example.test/inbox',
}

test.describe('Options data transfer', () => {
  test('exports a versioned json file with website metadata and cookie stores', async ({
    page, optionsUrl, mockServerUrl,
  }) => {
    const profiles: StoredProfile[] = [
      { id: 'transfer_export_a', name: 'Export A', hue: 212, site: SITE },
      { id: 'transfer_export_b', name: 'Export B', hue: 24 },
    ]

    await page.goto(optionsUrl)
    await page.evaluate(async ({ seeded, origin }) => {
      await chrome.storage.local.set({
        profiles: seeded,
        cookies_transfer_export_a: {
          session: { name: 'session', value: 'token-a', domain: 'localhost', path: '/' },
        },
        cookies_transfer_export_b: {},
        favorites: [{ id: 'fav_export', label: 'Keep out', url: `${origin}/x`, sessionId: 'transfer_export_a', createdAt: 1 }],
        ext_settings: { theme: 'dark' },
      })
    }, { seeded: profiles, origin: mockServerUrl })
    await page.reload()

    await expect(page.locator('#transferStatus')).toHaveAttribute('role', 'status')
    await expect(page.locator('#transferStatus')).toHaveAttribute('aria-live', 'polite')
    await expect(page.locator('#exportProfilesBtn')).toHaveText('Export profiles')

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exportProfilesBtn'),
    ])
    expect(download.suggestedFilename()).toMatch(/^sessionshift-profiles-\d{4}-\d{2}-\d{2}\.json$/)

    const filePath = await download.path()
    expect(filePath).not.toBeNull()
    if (filePath === null) throw new Error('Export download is missing')
    const raw = fs.readFileSync(filePath, 'utf8')
    const payload = parseProfileTransfer(raw)
    const fields = parseJsonObject(raw, 'Export')
    expect(payload.format).toBe('sessionshift-profile-export')
    expect(payload.version).toBe(1)
    expect(Number.isNaN(Date.parse(payload.exportedAt))).toBe(false)
    expect(payload.profiles).toEqual(profiles)
    expect(payload.cookies.transfer_export_a.session.value).toBe('token-a')
    expect(payload.cookies.transfer_export_b).toEqual({})
    // Tabs, favorites and extension settings stay on this device.
    expect(fields.favorites).toBeUndefined()
    expect(fields.ext_settings).toBeUndefined()
    expect(fields.tabs).toBeUndefined()

    await expect(page.locator('#transferStatus')).toHaveText('Profiles exported.')
  })

  test('imports an exported file and restores profiles, metadata and login cookies', async ({
    page, optionsUrl,
  }) => {
    const id = 'transfer_roundtrip'
    const profile: StoredProfile = { id, name: 'Round Trip', hue: 120, site: SITE }

    await page.goto(optionsUrl)
    await page.evaluate(async (seeded) => {
      await chrome.storage.local.set({
        profiles: [seeded],
        [`cookies_${seeded.id}`]: {
          session: { name: 'session', value: 'login-token', domain: 'localhost', path: '/' },
        },
      })
    }, profile)
    await page.reload()

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exportProfilesBtn'),
    ])
    // Playwright's download temp path has no extension; save it under the name a
    // user would actually pick so the file-type gate sees a real .json file.
    const savedPath = path.join(os.tmpdir(), `sessionshift-roundtrip-${Date.now()}.json`)
    await download.saveAs(savedPath)
    expect(path.basename(download.suggestedFilename())).toMatch(/\.json$/)

    try {
      // Simulate a reinstall / new device: nothing but the file survives.
      await page.evaluate(async () => { await chrome.storage.local.clear() })
      await page.reload()
      expect(await readProfiles(page)).toEqual([])

      await page.setInputFiles('#importProfilesFile', savedPath)

      await expect(page.locator('#transferStatus')).toHaveText('Imported profiles: 1.')
      expect(await readProfiles(page)).toEqual([profile])
      const store = await readCookieStore(page, id)
      expect(store.session.value).toBe('login-token')
    } finally {
      fs.rmSync(savedPath, { force: true })
    }
  })

  test('skips a conflicting profile id and preserves local data', async ({
    page, optionsUrl,
  }) => {
    const transfer = JSON.stringify({
      format: 'sessionshift-profile-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      profiles: [{ id: 'transfer_dup', name: 'Work', hue: 212, site: SITE }],
      cookies: {
        transfer_dup: { user: { name: 'user', value: 'imported', domain: 'localhost', path: '/' } },
      },
    })

    await page.goto(optionsUrl)
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        profiles: [{ id: 'transfer_dup', name: 'Work', hue: 24 }],
        cookies_transfer_dup: { user: { name: 'user', value: 'local', domain: 'localhost', path: '/' } },
      })
    })
    await page.reload()

    await page.setInputFiles('#importProfilesFile', {
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(transfer),
    })

    await expect(page.locator('#transferStatus')).toHaveText('Imported profiles: 0.')

    const profiles = await readProfiles(page)
    expect(profiles).toEqual([{ id: 'transfer_dup', name: 'Work', hue: 24 }])
    expect((await readCookieStore(page, 'transfer_dup')).user.value).toBe('local')
  })

  test('keeps the profile count stable when the same backup is imported twice', async ({
    page, optionsUrl,
  }) => {
    const transfer = JSON.stringify({
      format: 'sessionshift-profile-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      profiles: [{ id: 'transfer_repeat', name: 'Repeat', hue: 120, site: SITE }],
      cookies: {
        transfer_repeat: { user: { name: 'user', value: 'imported', domain: 'localhost', path: '/' } },
      },
    })

    await page.goto(optionsUrl)
    await page.evaluate(async () => { await chrome.storage.local.set({ profiles: [] }) })
    await page.reload()

    const file = {
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(transfer),
    }
    await page.setInputFiles('#importProfilesFile', file)
    await expect(page.locator('#transferStatus')).toHaveText('Imported profiles: 1.')

    await page.setInputFiles('#importProfilesFile', file)
    await expect(page.locator('#transferStatus')).toHaveText('Imported profiles: 0.')

    expect(await readProfiles(page)).toEqual([
      { id: 'transfer_repeat', name: 'Repeat', hue: 120, site: SITE },
    ])
    expect((await readCookieStore(page, 'transfer_repeat')).user.value).toBe('imported')
  })

  test('reports localized errors for malformed and unsupported files', async ({ page, optionsUrl }) => {
    await page.goto(optionsUrl)
    await page.evaluate(async () => { await chrome.storage.local.set({ profiles: [] }) })
    await page.reload()

    const status = page.locator('#transferStatus')
    await expect(status).toHaveAttribute('role', 'status')

    await page.setInputFiles('#importProfilesFile', {
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{ not json'),
    })
    await expect(status).toHaveText('The selected file is not valid JSON.')

    await page.setInputFiles('#importProfilesFile', {
      name: 'future.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        format: 'sessionshift-profile-export',
        version: 99,
        exportedAt: new Date().toISOString(),
        profiles: [],
        cookies: {},
      })),
    })
    await expect(status).toHaveText('This is not a supported SessionShift export.')

    await page.setInputFiles('#importProfilesFile', {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not an export'),
    })
    await expect(status).toHaveText('This is not a supported SessionShift export.')

    // A rejected file never mutates stored profiles.
    expect(await readProfiles(page)).toEqual([])
  })
})
