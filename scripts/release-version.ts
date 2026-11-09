import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

export function readJsonObject(file: string): Record<string, unknown> {
  return parseJsonObject(readFileSync(file, 'utf8'), file)
}

export function validateVersions(packageVersion: unknown, manifestVersion: unknown, tag?: string): string {
  if (typeof packageVersion !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageVersion)) {
    throw new Error('package.json version must be a stable X.Y.Z version')
  }
  const parts = packageVersion.split('.').map(Number)
  if (parts.some(part => part > 65535) || parts.every(part => part === 0)) {
    throw new Error('Extension version components must be 0..65535 and not all zero')
  }
  if (manifestVersion !== packageVersion) {
    throw new Error(`Manifest version ${String(manifestVersion)} does not match package.json ${packageVersion}`)
  }
  if (tag !== undefined && tag !== `v${packageVersion}`) {
    throw new Error(`Tag ${tag} does not match package.json v${packageVersion}`)
  }
  return packageVersion
}

export function readVersion(root = ROOT, tag?: string): string {
  return validateVersions(
    readJsonObject(path.join(root, 'package.json')).version,
    readJsonObject(path.join(root, 'src/manifest.json')).version,
    tag,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(readVersion(undefined, process.argv[2]))
}
