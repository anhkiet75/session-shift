import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

import { parseJsonObject } from './release-version.js'

const LOCAL_FILE_HEADER = 0x04034b50
const CENTRAL_DIRECTORY_HEADER = 0x02014b50
const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const END_OF_CENTRAL_DIRECTORY_MIN_SIZE = 22
const MAX_ZIP_COMMENT_SIZE = 0xffff
const DATA_DESCRIPTOR_FLAG = 0x0008
const ENCRYPTED_FLAG = 0x0001
const UTF8_FLAG = 0x0800
const UNIX_FILE_TYPE_MASK = 0xf000
const UNIX_SYMLINK = 0xa000
const UNIX_REGULAR_FILE = 0x8000
const DOS_DIRECTORY_ATTRIBUTE = 0x0010

export type ExtensionZip = {
  buffer: Buffer
  entries: Map<string, Buffer>
  manifest: Record<string, unknown>
}

type CentralDirectoryEntry = {
  name: string
  method: number
  flags: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  externalAttributes: number
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return crc >>> 0
})

function fail(message: string): never {
  throw new Error(message)
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function requireRange(buffer: Buffer, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    fail(`Truncated ${label}`)
  }
}

function readUInt16(buffer: Buffer, offset: number, label: string): number {
  requireRange(buffer, offset, 2, label)
  return buffer.readUInt16LE(offset)
}

function readUInt32(buffer: Buffer, offset: number, label: string): number {
  requireRange(buffer, offset, 4, label)
  return buffer.readUInt32LE(offset)
}

function safeEntryName(rawName: Buffer, flags: number): string {
  if ((flags & UTF8_FLAG) === 0 && rawName.some(byte => byte > 0x7f)) {
    fail('ZIP entry names must be UTF-8 or ASCII')
  }
  const name = rawName.toString('utf8')
  if (name.length === 0 || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    fail(`Unsafe ZIP entry name: ${JSON.stringify(name)}`)
  }
  if (name.endsWith('/')) fail(`ZIP directory entries are not allowed: ${JSON.stringify(name)}`)
  const parts = name.split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..')) {
    fail(`Unsafe ZIP entry path: ${JSON.stringify(name)}`)
  }
  return name
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimumOffset = Math.max(0, buffer.length - END_OF_CENTRAL_DIRECTORY_MIN_SIZE - MAX_ZIP_COMMENT_SIZE)
  for (let offset = buffer.length - END_OF_CENTRAL_DIRECTORY_MIN_SIZE; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + END_OF_CENTRAL_DIRECTORY_MIN_SIZE + commentLength === buffer.length) return offset
  }
  fail('ZIP end-of-central-directory record is missing')
}

function readCentralDirectory(buffer: Buffer, offset: number, size: number, count: number): CentralDirectoryEntry[] {
  requireRange(buffer, offset, size, 'ZIP central directory')
  const entries: CentralDirectoryEntry[] = []
  const names = new Set<string>()
  let cursor = offset

  for (let index = 0; index < count; index += 1) {
    if (readUInt32(buffer, cursor, 'ZIP central-directory header') !== CENTRAL_DIRECTORY_HEADER) {
      fail(`ZIP central-directory entry ${index + 1} has an invalid signature`)
    }
    requireRange(buffer, cursor, 46, 'ZIP central-directory header')
    const flags = readUInt16(buffer, cursor + 8, 'ZIP central-directory flags')
    const method = readUInt16(buffer, cursor + 10, 'ZIP central-directory compression method')
    const crc = readUInt32(buffer, cursor + 16, 'ZIP central-directory CRC')
    const compressedSize = readUInt32(buffer, cursor + 20, 'ZIP central-directory compressed size')
    const uncompressedSize = readUInt32(buffer, cursor + 24, 'ZIP central-directory uncompressed size')
    const nameLength = readUInt16(buffer, cursor + 28, 'ZIP central-directory name length')
    const extraLength = readUInt16(buffer, cursor + 30, 'ZIP central-directory extra length')
    const commentLength = readUInt16(buffer, cursor + 32, 'ZIP central-directory comment length')
    const externalAttributes = readUInt32(buffer, cursor + 38, 'ZIP central-directory attributes')
    const localHeaderOffset = readUInt32(buffer, cursor + 42, 'ZIP central-directory local-header offset')
    requireRange(buffer, cursor + 46, nameLength + extraLength + commentLength, 'ZIP central-directory entry')
    const name = safeEntryName(buffer.subarray(cursor + 46, cursor + 46 + nameLength), flags)
    if (names.has(name)) fail(`ZIP contains duplicate entry: ${name}`)
    names.add(name)

    entries.push({ name, method, flags, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset, externalAttributes })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  if (cursor !== offset + size) fail('ZIP central-directory size does not match its entries')
  return entries
}

function readEntry(buffer: Buffer, entry: CentralDirectoryEntry): Buffer {
  if ((entry.flags & ENCRYPTED_FLAG) !== 0) fail(`Encrypted ZIP entries are not supported: ${entry.name}`)
  if ((entry.externalAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0) fail(`ZIP directory entries are not allowed: ${entry.name}`)
  const unixMode = (entry.externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK
  if (unixMode === UNIX_SYMLINK) fail(`ZIP symlinks are not allowed: ${entry.name}`)
  if (unixMode !== 0 && unixMode !== UNIX_REGULAR_FILE) fail(`ZIP entry is not a regular file: ${entry.name}`)

  if (readUInt32(buffer, entry.localHeaderOffset, `ZIP local header for ${entry.name}`) !== LOCAL_FILE_HEADER) {
    fail(`ZIP entry ${entry.name} has an invalid local-header signature`)
  }
  requireRange(buffer, entry.localHeaderOffset, 30, `ZIP local header for ${entry.name}`)
  const localFlags = readUInt16(buffer, entry.localHeaderOffset + 6, `ZIP local flags for ${entry.name}`)
  const localMethod = readUInt16(buffer, entry.localHeaderOffset + 8, `ZIP local compression method for ${entry.name}`)
  const nameLength = readUInt16(buffer, entry.localHeaderOffset + 26, `ZIP local name length for ${entry.name}`)
  const extraLength = readUInt16(buffer, entry.localHeaderOffset + 28, `ZIP local extra length for ${entry.name}`)
  requireRange(buffer, entry.localHeaderOffset + 30, nameLength + extraLength, `ZIP local header for ${entry.name}`)
  const localName = safeEntryName(buffer.subarray(entry.localHeaderOffset + 30, entry.localHeaderOffset + 30 + nameLength), localFlags)
  if (localName !== entry.name) fail(`ZIP local header name does not match central directory: ${entry.name}`)
  if (localMethod !== entry.method) fail(`ZIP local header compression method does not match central directory: ${entry.name}`)
  if (((localFlags ^ entry.flags) & (ENCRYPTED_FLAG | DATA_DESCRIPTOR_FLAG)) !== 0) {
    fail(`ZIP local header flags do not match central directory: ${entry.name}`)
  }

  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength
  requireRange(buffer, dataOffset, entry.compressedSize, `ZIP data for ${entry.name}`)
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize)
  let data: Buffer
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) fail(`Stored ZIP entry has inconsistent sizes: ${entry.name}`)
    data = Buffer.from(compressed)
  } else if (entry.method === 8) {
    try {
      data = inflateRawSync(compressed)
    } catch (error) {
      fail(`ZIP entry ${entry.name} could not be decompressed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    fail(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`)
  }

  if (data.length !== entry.uncompressedSize) fail(`ZIP entry size mismatch: ${entry.name}`)
  if (crc32(data) !== entry.crc32) fail(`ZIP entry CRC mismatch: ${entry.name}`)
  return data
}

export function readZipArchive(input: Buffer | string): Map<string, Buffer> {
  const buffer = typeof input === 'string' ? readFileSync(input) : input
  if (buffer.length < END_OF_CENTRAL_DIRECTORY_MIN_SIZE) fail('ZIP archive is empty or truncated')
  const eocdOffset = findEndOfCentralDirectory(buffer)
  const diskNumber = readUInt16(buffer, eocdOffset + 4, 'ZIP disk number')
  const centralDisk = readUInt16(buffer, eocdOffset + 6, 'ZIP central-directory disk')
  const entriesOnDisk = readUInt16(buffer, eocdOffset + 8, 'ZIP entries on disk')
  const entryCount = readUInt16(buffer, eocdOffset + 10, 'ZIP entry count')
  const centralSize = readUInt32(buffer, eocdOffset + 12, 'ZIP central-directory size')
  const centralOffset = readUInt32(buffer, eocdOffset + 16, 'ZIP central-directory offset')
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    fail('Multi-disk ZIP archives are not supported')
  }
  if (entryCount === 0) fail('ZIP archive contains no entries')
  if (centralOffset + centralSize > eocdOffset) fail('ZIP central directory overlaps the end record')

  const centralEntries = readCentralDirectory(buffer, centralOffset, centralSize, entryCount)
  const entries = new Map<string, Buffer>()
  for (const entry of centralEntries) entries.set(entry.name, readEntry(buffer, entry))
  return entries
}

export function readExtensionZip(input: Buffer | string, expectedVersion: string): ExtensionZip {
  const buffer = typeof input === 'string' ? readFileSync(input) : input
  const entries = readZipArchive(buffer)
  const manifestBuffer = entries.get('manifest.json')
  if (!manifestBuffer) fail('Extension ZIP is missing manifest.json')
  const manifest = parseJsonObject(manifestBuffer.toString('utf8'), 'ZIP manifest.json')
  if (manifest.version !== expectedVersion) {
    fail(`ZIP manifest version ${JSON.stringify(manifest.version)} does not match ${expectedVersion}`)
  }
  return { buffer, entries, manifest }
}
