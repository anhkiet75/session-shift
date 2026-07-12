---
phase: 2
title: "Runtime adapter, settings, build, and package"
status: complete
priority: P1
dependencies: [1]
---

# Phase 2: Runtime adapter, settings, build, and package

## Context Links

- [Chrome runtime architecture](../reports/researcher-260712-chrome-i18n-rtl.md)
- [Build/test delivery](../reports/researcher-260712-localization-test-delivery.md)
- [Bundle-size plan](../260522-1335-bundle-size-reduction/plan.md)

## Overview

Implement one dependency-free adapter with native Chrome System mode, packaged manual catalogs, English fallback, concurrency-safe preference/application, representative `de/ar/fa/he` catalogs, and build/dev/package delivery.

## Key Insights

- `chrome.i18n.getMessage()` cannot target a manual locale. System must use native resolution; manual mode loads allowlisted packaged JSON.
- Manual preference cannot override manifest name/description/commands. Model runtime and manifest locale authorities separately.
- MV3 worker cache is ephemeral; `ext_settings` remains source of truth and context menus must tolerate cold starts.
- Language preference stays in existing `chrome.storage.local` key `ext_settings`; cross-device sync is explicitly outside this plan.

## Requirements

- Functional: persist `system | SupportedLocale` in existing local `ext_settings`; serialize field-level settings mutations; resolve messages/placeholders; apply last-write-wins locale generations; coalesce menu rebuilds; seed `de/ar/fa/he`; copy/watch/package `_locales`.
- Non-functional: local-only fetch via `chrome.runtime.getURL`; validated locale before path construction; cache only active+English per context; preserve all settings fields.

## Architecture

`createLocalizer(preference)` selects native Chrome resolution for `system` or packaged resolution for manual. Manual lookup is exact selected catalog → English only. Preference is a field of the existing `chrome.storage.local` `ext_settings` object; no `storage.sync`, migration, or roaming behavior is added. A serialized mutator re-reads and updates one field inside a per-context queue. Each async locale application commits only if its monotonic generation is latest. Context-menu requests share one in-flight rebuild and coalesce one trailing rebuild.

## Related Code Files

| Action | Absolute path | Purpose |
|---|---|---|
| Create | `/Users/takiet/Documents/chrome_extension_multiple_session/src/lib/localization.ts` | Catalog load/cache, resolution, interpolation, document metadata |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/lib/localization-types.ts` | Runtime contracts finalized |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/lib/types.ts` | Add optional language preference |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/lib/settings-store.ts` | Defaults/read/write/storage listener helpers |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/manifest.json` | `default_locale: en`; manifest `__MSG_*__` tokens |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/scripts/build.sh` | Recursive `_locales` copy integrated after bundle-plan rebase |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/scripts/dev-watch-static.mjs` | Watch/copy `_locales` changes and new locale dirs |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/scripts/package.sh` | Package integrity invocation/derived archive path |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/scripts/dev.sh` | Clean initial `_locales` copy before watchers start |
| Create | `/Users/takiet/Documents/chrome_extension_multiple_session/scripts/validate-localization-artifacts.mjs` | Single source/dist/ZIP artifact validation command |
| Create | `/Users/takiet/Documents/chrome_extension_multiple_session/src/_locales/{de,ar,fa,he}/messages.json` | Representative catalogs required by Phase 3/4 |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/package.json` | Validation/build sequencing as needed |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/tests/localization-runtime.test.ts` | Resolver/settings/cache/direction tests |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/tests/manifest-permissions.test.js` | Manifest locale/token assertions without changing permissions |

## File Inventory

| Absolute file/group path | Planned change | Coordination |
|---|---|---|
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/lib/types.ts`; `/Users/takiet/Documents/chrome_extension_multiple_session/src/lib/settings-store.ts` | Optional language; absent means System | Preserve theme/inheritance and future fields |
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/lib/localization.ts` | Single catalog format, two resolution backends | No i18next/ICU dependency |
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/manifest.json` | Localize description/commands; brand literal or catalog key | Chrome UI locale only |
| `/Users/takiet/Documents/chrome_extension_multiple_session/scripts/build.sh`; `/Users/takiet/Documents/chrome_extension_multiple_session/scripts/dev-watch-static.mjs`; `/Users/takiet/Documents/chrome_extension_multiple_session/scripts/package.sh` | Recursively deliver `_locales` | Rebase; retain minification/compression |

## Function / Interface Checklist

- [ ] `getLanguagePreference()` validates stored value and returns `system` on absent/invalid.
- [ ] Preference reads/writes only `chrome.storage.local` `ext_settings`; no cross-device sync path exists.
- [ ] `mutateExtSettingsField(field, value)` serializes field-level read-modify-write; language/theme/inheritance callers use it.
- [ ] `loadCatalog(locale)` allowlists before `getURL`, checks `response.ok`, schema, and caches promise.
- [ ] `createLocalizer(preference)` / `getMessage(key, substitutions)` implements native/manual/English fallback and named ordering.
- [ ] `getResolvedLanguageTag()` and `getTextDirection()` produce BCP 47 `lang` and `rtl|ltr`.
- [ ] `applyDocumentLocale(document, localizer)` updates `<html>` metadata idempotently.
- [ ] Settings listener ignores unrelated changes and emits/rebuilds once per language change.
- [ ] Locale-application generation prevents stale fetch/render completion from overwriting the latest selection.
- [ ] Context-menu scheduler is single-flight and coalesces rapid changes into at most one trailing rebuild.
- [ ] `npm run validate:localization-artifacts -- [dist|zip]` owns source/dist/package file, token, regular-file, and parity checks.

## Dependency Map

`Phase 1 contracts → settings preference → adapter backends → manifest/build delivery → page/background consumers in Phase 3`.

## Implementation Steps

1. Reconcile `scripts/build.sh` with the bundle-size branch/plan; preserve minification semantics and add recursive catalog copy at the correct stage.
2. Extend local `ExtSettings` with optional language preference and a serialized field-level mutation API. Treat absent/invalid as `system`; never rewrite storage just to migrate defaults. Do not add `chrome.storage.sync` or cross-device migration. Test overlapping language/theme/inheritance writes and external local-storage changes.
3. Implement packaged loader with exact allowlist, schema validation, per-context cache, and exact-selected → English manual fallback. Never fetch all 55 catalogs or use a generic-parent manual fallback.
4. Implement System backend using native Chrome lookup/fallback; use packaged English only when native returns empty/undefined.
5. Implement Chrome-compatible named placeholder substitution and document language/direction helpers.
6. Add `default_locale: "en"` and valid manifest tokens for localizable browser-owned fields; document tests must assert manual limitation.
7. Add complete representative `de/ar/fa/he` catalogs and validate them before any Phase 3/4 E2E or visual test.
8. Update build/watch/package paths. `npm run dev` must clean/copy manifest, UI assets, and `_locales` before watchers start; later file additions/changes must also copy.
9. Add monotonic locale-application generation and single-flight/trailing-coalesced context-menu rebuild orchestration.
10. Implement one artifact validator command for source/dist/ZIP; reject symlinks, non-regular files, and unexpected catalog/package entries.
11. Add runtime/settings/manifest/build tests, including cold worker, concurrent setting writes, rapid locale flips, menu rebuild storms, and clean dev startup.

## Test Scenario Matrix

| Scenario | Level | Expected |
|---|---|---|
| No language field / invalid stored locale | Unit | System; other settings unchanged |
| System native key missing | Unit | Packaged English, never blank |
| `pt_BR` manual missing key | Unit | Exact selected catalog then English; no generic parent |
| Malicious `../manifest` locale | Unit | Rejected before URL construction |
| Placeholder reorder and hostile user value | Unit | Correct text; no HTML interpretation |
| Worker cold start + language change | Unit/integration | Reads storage, resolves, rebuild signal idempotent |
| Clean build/dev change/package | Build | All 55 eventually supported; current catalogs copied exactly; no unresolved manifest token |
| Theme/inheritance settings present | Unit/E2E | Preserved after language change |
| Concurrent language/theme/inheritance writes | Unit/integration | Serialized field changes all survive |
| Storage backend contract | Unit | Only local `ext_settings` touched; no sync call/migration |
| `de → ar → he` with delayed fetches | Unit | Only newest generation mutates document/state |
| Rapid storage/menu events | Unit | One in-flight plus at most one trailing rebuild |
| Clean `npm run dev` | Integration | Initial `dist/_locales` exists before watchers; subsequent changes copied |
| Artifact tree symlink/unexpected file | Integration | Single validator command fails closed |

## Todo List

- [x] Rebase shared build pipeline.
- [x] Extend settings contract safely.
- [x] Seed validated `de/ar/fa/he` catalogs.
- [x] Add last-write-wins locale application and coalesced menu rebuild.
- [x] Implement native/manual adapter and English fallback.
- [x] Localize manifest-owned fields.
- [x] Copy/watch/package catalogs.
- [x] Pass runtime, manifest, build tests.
- [x] Own and pass the single artifact validation command.

## Success Criteria

- [x] System and manual resolution contracts pass, including cold start and missing keys.
- [x] Invalid stored/message-supplied locale cannot address arbitrary package paths.
- [x] Manifest contains valid `default_locale` and English-resolving tokens.
- [x] Clean build and package include validated catalog bytes.
- [x] No production dependency or user-setting regression.

## Risk Assessment

Build conflict is highest: explicitly rebase rather than overwrite bundle-size changes. Native/manual authority confusion is mitigated by separate names/tests and UI copy. Worker lifetime is mitigated by lazy cold-safe reads.

## Security Considerations

Do not declare catalogs as web-accessible. Do not accept arbitrary locale path fragments or remote catalogs. Render resolved messages as text. Validate placeholder parity so destructive qualifiers cannot silently disappear.

## Next Steps

Phase 3 consumes only the tested adapter. Do not start mass surface replacement while build/package fallback tests are red.
