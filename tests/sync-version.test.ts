// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { syncVersion } from '../scripts/sync-version.js'

let root: string
function writeJson(file: string, data: unknown, newline = '\n'): void {
  writeFileSync(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`.replace(/\n/g, newline))
}
function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'session-shift-version-'))
  mkdirSync(path.join(root, 'src'))
  writeJson('src/manifest.json', { manifest_version: 3, version: '1.2.0' })
  writeJson('package.json', { name: 'test', version: '1.1.0', scripts: { test: 'vitest' } })
  writeJson('package-lock.json', {
    name: 'test', version: '1.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'test', version: '1.1.0', dependencies: { example: '2.0.0' } },
      'node_modules/example': { version: '2.0.0', integrity: 'unchanged' },
    },
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('manifest version synchronization', () => {
  it('synchronizes all package version fields without changing dependencies or the manifest', () => {
    const manifest = read('src/manifest.json')
    const packageBefore = read('package.json')
    const lockBefore = read('package-lock.json')
    expect(syncVersion(root)).toBe('1.2.0')
    expect(read('package.json')).toBe(packageBefore.replace('1.1.0', '1.2.0'))
    expect(read('package-lock.json')).toBe(lockBefore.replace('1.0.0', '1.2.0').replace('1.1.0', '1.2.0'))
    expect(read('src/manifest.json')).toBe(manifest)
  })

  it('preserves CRLF and does not rewrite synchronized files', () => {
    writeFileSync(path.join(root, 'package.json'), read('package.json').replace(/\n/g, '\r\n'))
    syncVersion(root)
    expect(read('package.json')).toContain('\r\n')
    const files = ['package.json', 'package-lock.json']
    const timestamps = files.map(file => statSync(path.join(root, file)).mtimeMs)
    syncVersion(root)
    expect(files.map(file => statSync(path.join(root, file)).mtimeMs)).toEqual(timestamps)
  })

  it.each(['01.2.3', '1.2.3-beta', '65536.0.0', '0.0.0', undefined])('rejects invalid manifest version %s before writing', version => {
    writeJson('src/manifest.json', { version })
    const before = [read('package.json'), read('package-lock.json')]
    expect(() => syncVersion(root)).toThrow()
    expect([read('package.json'), read('package-lock.json')]).toEqual(before)
  })

  it.each([
    { lockfileVersion: 2, packages: { '': {} } },
    { lockfileVersion: 3, packages: null },
    { lockfileVersion: 3, packages: {} },
    { lockfileVersion: 3, packages: { '': [] } },
  ])('rejects malformed lockfile metadata before writing packages: %j', lock => {
    writeJson('package-lock.json', lock)
    const before = [read('package.json'), read('package-lock.json')]
    expect(() => syncVersion(root)).toThrow('package-lock.json')
    expect([read('package.json'), read('package-lock.json')]).toEqual(before)
  })
})
