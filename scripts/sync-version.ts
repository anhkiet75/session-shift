import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, parseJsonObject, readJsonObject, validateVersion } from './release-version.js'

export function syncVersion(root = ROOT): string {
  const version = validateVersion(readJsonObject(path.join(root, 'src/manifest.json')).version, 'src/manifest.json')
  const packageFile = path.join(root, 'package.json')
  const lockFile = path.join(root, 'package-lock.json')
  const packageRaw = readFileSync(packageFile, 'utf8')
  const lockRaw = readFileSync(lockFile, 'utf8')
  const packageJson = parseJsonObject(packageRaw, packageFile)
  const lock = parseJsonObject(lockRaw, lockFile)
  if (lock.lockfileVersion !== 3) throw new Error('package-lock.json must use lockfileVersion 3')
  const packages = lock.packages
  if (typeof packages !== 'object' || packages === null || Array.isArray(packages)) {
    throw new Error('package-lock.json must contain a packages object')
  }
  const rootPackage: unknown = (packages as Record<string, unknown>)['']
  if (typeof rootPackage !== 'object' || rootPackage === null || Array.isArray(rootPackage)) {
    throw new Error('package-lock.json must contain a root package')
  }
  packageJson.version = version
  lock.version = version
  const rootMetadata = rootPackage as Record<string, unknown>
  rootMetadata.version = version
  for (const [file, raw, data] of [
    [packageFile, packageRaw, packageJson],
    [lockFile, lockRaw, lock],
  ] as const) {
    const newline = raw.includes('\r\n') ? '\r\n' : '\n'
    const updated = `${JSON.stringify(data, null, 2)}\n`.replace(/\n/g, newline)
    if (updated !== raw) writeFileSync(file, updated)
  }
  return version
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(syncVersion())
}
