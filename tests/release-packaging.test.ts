// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { validateVersions, parseJsonObject } from '../scripts/release-version.js'
import { validateRelease } from '../scripts/validate-release.js'
import { buildCrx, loadPrivateKey, verifyCrx } from '../scripts/package-crx.js'
import { readExtensionZip } from '../scripts/extension-zip.js'

const temporaryDirectories: string[] = []
beforeEach(() => {
  vi.stubEnv('CRX_PRIVATE_KEY', '')
  vi.stubEnv('CRX_PRIVATE_KEY_BASE64', '')
  vi.stubEnv('CRX_PRIVATE_KEY_PATH', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// Independent ZIP fixture writer exercises both supported compression methods.
function zipFixture(version = '0.1.3', name = 'manifest.json', method = 8): Buffer {
  const data = Buffer.from(JSON.stringify({ manifest_version: 3, version, name: 'Test' }))
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  crc = (crc ^ 0xffffffff) >>> 0
  const compressed = method === 8 ? deflateRawSync(data) : data
  const filename = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(method, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(filename.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + filename.length, 12)
  end.writeUInt32LE(local.length + filename.length + compressed.length, 16)
  return Buffer.concat([local, filename, compressed, central, filename, end])
}

describe('release version gate', () => {
  it('accepts an exact stable tag, package and manifest version', () => {
    expect(validateVersions('0.1.3', '0.1.3', 'v0.1.3')).toBe('0.1.3')
    expect(validateVersions('65535.0.1', '65535.0.1', 'v65535.0.1')).toBe('65535.0.1')
  })
  it.each([undefined, '01.1.3', '0.1.3-beta', '0.1', '65536.1.0', '0.0.0', '1.2.3.4'])('rejects invalid package version %s', version => {
    expect(() => validateVersions(version, version)).toThrow()
  })
  it('rejects mismatched tags and manifests', () => {
    expect(() => validateVersions('0.1.3', '0.1.3', 'v0.1.4')).toThrow('Tag')
    expect(() => validateVersions('0.1.3', '0.1.2', 'v0.1.3')).toThrow('Manifest')
    expect(() => validateRelease(undefined)).toThrow('tag')
  })
  it('rejects non-object and malformed JSON at the file boundary', () => {
    for (const raw of ['null', '[]', 'false', '{']) expect(() => parseJsonObject(raw, 'Fixture')).toThrow()
  })
})

describe('release signing and archive verification', () => {
  it.each(['pkcs1', 'pkcs8'] as const)('signs with the raw %s PEM used by GitHub variables', type => {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    vi.stubEnv('CRX_PRIVATE_KEY', privateKey.export({ type, format: 'pem' }).toString())
    expect(validateRelease('v0.1.3')).toBe('0.1.3')
    const { key, source } = loadPrivateKey(true)
    expect(source).toBe('CRX_PRIVATE_KEY')
    const { crx, extensionId } = buildCrx(key, zipFixture())
    const directory = mkdtempSync(path.join(tmpdir(), 'session-shift-pem-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'extension.crx')
    writeFileSync(file, crx)
    expect(() => verifyCrx(file, extensionId, '0.1.3')).not.toThrow()
    expect(buildCrx(privateKey, zipFixture()).extensionId).toBe(extensionId)
  })
  it('rejects malformed PEM, non-RSA keys, weak RSA keys and conflicting key sources', () => {
    vi.stubEnv('CRX_PRIVATE_KEY', 'invalid PEM')
    expect(() => loadPrivateKey(true)).toThrow('CRX_PRIVATE_KEY is not a valid PEM')
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    vi.stubEnv('CRX_PRIVATE_KEY', ec.export({ type: 'pkcs8', format: 'pem' }).toString())
    expect(() => loadPrivateKey(true)).toThrow('RSA')
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey
    vi.stubEnv('CRX_PRIVATE_KEY', weak.export({ type: 'pkcs1', format: 'pem' }).toString())
    expect(() => loadPrivateKey(true)).toThrow('2048')
    vi.stubEnv('CRX_PRIVATE_KEY_BASE64', 'configured')
    expect(() => loadPrivateKey(true)).toThrow('Set only one')
    vi.stubEnv('CRX_PRIVATE_KEY_BASE64', '')
    vi.stubEnv('CRX_PRIVATE_KEY_PATH', 'key.pem')
    expect(() => loadPrivateKey(true)).toThrow('Set only one')
  })
  it('requires a valid fixed RSA key for releases while allowing local temporary keys', () => {
    vi.stubEnv('CRX_PRIVATE_KEY_BASE64', '')
    vi.stubEnv('CRX_PRIVATE_KEY_PATH', '')
    expect(() => loadPrivateKey(true)).toThrow('CRX_PRIVATE_KEY_BASE64')
    expect(loadPrivateKey().source).toBe('ephemeral')
    vi.stubEnv('CRX_PRIVATE_KEY_BASE64', Buffer.from('PRIVATE KEY invalid').toString('base64'))
    expect(() => loadPrivateKey(true)).toThrow('valid PEM')
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    vi.stubEnv('CRX_PRIVATE_KEY_BASE64', Buffer.from(ec.export({ type: 'pkcs8', format: 'pem' })).toString('base64'))
    expect(() => loadPrivateKey(true)).toThrow('RSA')
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey
    vi.stubEnv('CRX_PRIVATE_KEY_BASE64', Buffer.from(weak.export({ type: 'pkcs8', format: 'pem' })).toString('base64'))
    expect(() => loadPrivateKey(true)).toThrow('2048')
  })
  it.each([0, 8])('reads ZIP method %s and rejects internal version mismatches', method => {
    expect(readExtensionZip(zipFixture('0.1.3', 'manifest.json', method), '0.1.3').entries.size).toBe(1)
    expect(() => readExtensionZip(zipFixture('0.1.2'), '0.1.3')).toThrow('version')
  })
  it('rejects unsafe paths, corrupt data and truncated archives', () => {
    expect(() => readExtensionZip(zipFixture('0.1.3', '../manifest.json'), '0.1.3')).toThrow('Unsafe')
    const corrupt = zipFixture('0.1.3', 'manifest.json', 0)
    corrupt[44] ^= 1
    expect(() => readExtensionZip(corrupt, '0.1.3')).toThrow('CRC')
    expect(() => readExtensionZip(Buffer.alloc(4), '0.1.3')).toThrow('truncated')
  })
  it('verifies RSA signatures, stable extension IDs, embedded versions and tampering', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'session-shift-release-'))
    temporaryDirectories.push(directory)
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    vi.stubEnv('CRX_PRIVATE_KEY_PATH', '')
    vi.stubEnv('CRX_PRIVATE_KEY_BASE64', Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'))
    const { key } = loadPrivateKey(true)
    const { crx, extensionId } = buildCrx(key, zipFixture())
    const file = path.join(directory, 'session_shift_v0.1.3.crx')
    writeFileSync(file, crx)
    expect(() => verifyCrx(file, extensionId, '0.1.3')).not.toThrow()
    expect(buildCrx(key, zipFixture()).extensionId).toBe(extensionId)
    expect(() => verifyCrx(file, extensionId, '0.1.4')).toThrow('version')
    expect(() => verifyCrx(file, 'invalid', '0.1.3')).toThrow('ID')
    // Replace the ZIP with another valid encoding so only signature verification fails.
    const headerEnd = 12 + crx.readUInt32LE(8)
    writeFileSync(file, Buffer.concat([crx.subarray(0, headerEnd), zipFixture('0.1.3', 'manifest.json', 0)]))
    expect(() => verifyCrx(file, extensionId, '0.1.3')).toThrow('signature')
    writeFileSync(file, crx.subarray(0, 10))
    expect(() => verifyCrx(file, extensionId, '0.1.3')).toThrow('CRX3')
  })
})
