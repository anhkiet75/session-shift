import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Cross-phase guard (#14): the cookies-permission removal (Phase 2) and the
// alarms-permission addition (Phase 5) edit the same permissions array. Assert
// the built/source manifest reflects BOTH so a merge can't clobber one.
describe('manifest permissions', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/manifest.json'), 'utf8'),
  )

  it('includes alarms (Phase 5) and excludes cookies (Phase 2)', () => {
    expect(manifest.permissions).toContain('alarms')
    expect(manifest.permissions).not.toContain('cookies')
  })
})
