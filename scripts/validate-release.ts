import { fileURLToPath } from 'node:url'
import { readVersion } from './release-version.js'
import { loadPrivateKey } from './package-crx.js'

export function validateRelease(tag: string | undefined): string {
  if (!tag) throw new Error('A release tag is required')
  const version = readVersion(undefined, tag)
  loadPrivateKey(true)
  return version
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(validateRelease(process.argv[2]))
}
