---
phase: 1
title: "Localization contracts and regression seams"
status: complete
priority: P1
dependencies: []
---

# Phase 1: Localization contracts and regression seams

## Context Links

- [Approved design](../reports/brainstorm-260712-1324-complete-localization-rtl.md)
- [Code inventory](../reports/researcher-260712-localization-code-inventory.md)
- [Test/delivery research](../reports/researcher-260712-localization-test-delivery.md)
- [Chrome i18n/RTL research](../reports/researcher-260712-chrome-i18n-rtl.md)

## Overview

Freeze the catalog, locale, placeholder, user-data, and selector contracts before runtime or UI refactors. Deliver canonical English, deterministic validation, runtime test seams, and locale-independent E2E actions.

## Key Insights

- `_locales/en/messages.json` is the canonical key contract; Chrome keys are restricted and `@@` is reserved.
- Existing E2E actions coupled to English ARIA/text will become false failures. Stable action selectors must coexist with localized accessibility assertions.
- `Session N` becomes user data at creation. Translate the generated default once, store the resulting string, then never relocalize/migrate it.
- Duplicate's generated `" (copy)"` suffix has the same lifecycle: localize at duplication, store the complete name, then preserve bytes forever.

## Requirements

- Functional: inventory manifest, popup, Options, context-menu, dynamic, title, placeholder, ARIA, confirmation, and live-region messages; define typed key/substitution contracts and exact 55-locale allowlist.
- Non-functional: no production dependency; validator deterministic/offline; no change to session/profile/domain/URL/cookie/import/export values.

## Architecture

English catalog drives a checked `MessageKey` contract. `scripts/validate-locales.mjs` validates explicit HTML localization markers, explicit catalog/key registries, manifest tokens, placeholder parity, locale allowlist, and quality metadata; it does not attempt generic TypeScript parsing. Tests use stable `data-action`/`data-testid` for interaction while separately checking localized semantics.

## Related Code Files

| Action | Absolute path | Purpose |
|---|---|---|
| Create | `/Users/takiet/Documents/chrome_extension_multiple_session/src/_locales/en/messages.json` | Complete canonical Chrome message catalog |
| Create | `/Users/takiet/Documents/chrome_extension_multiple_session/src/lib/localization-types.ts` | Locale/key/catalog/placeholder types and constants |
| Create | `/Users/takiet/Documents/chrome_extension_multiple_session/scripts/validate-locales.mjs` | Offline contract validator |
| Create | `/Users/takiet/Documents/chrome_extension_multiple_session/tests/localization-catalog.test.ts` | Catalog and reference contract tests |
| Create | `/Users/takiet/Documents/chrome_extension_multiple_session/tests/localization-runtime.test.ts` | Adapter-facing regression seam/tests, initially contract-focused |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/package.json` | Add `validate:locales` script |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/tests/e2e/session-crud.test.ts` | Replace English action coupling |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/tests/e2e/profile-open-in-new-tab.test.ts` | Add stable open-tab action selector |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/tests/e2e/theme-switcher.test.ts` | Separate stable interaction from localized ARIA checks |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/lib/session-store.ts` | Creation-time localized duplicate-name contract |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/background/message-handler.ts` | Supply localized duplicate suffix/message input |

## File Inventory

| Absolute file/group path | Current state | Planned seam |
|---|---|---|
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/manifest.json`; `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/`; `/Users/takiet/Documents/chrome_extension_multiple_session/src/options/` | English embedded | Every visible message assigned one stable key; implementation deferred |
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/_locales/en/messages.json` | Missing | Complete canonical messages, translator descriptions, named placeholders |
| `/Users/takiet/Documents/chrome_extension_multiple_session/tests/e2e/session-crud.test.ts`; `/Users/takiet/Documents/chrome_extension_multiple_session/tests/e2e/profile-open-in-new-tab.test.ts`; `/Users/takiet/Documents/chrome_extension_multiple_session/tests/e2e/theme-switcher.test.ts` | English selector coupling | Stable action attributes; semantic assertions remain locale-aware |
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/lib/types.ts`; `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/popup.ts` | Plain stored strings | Never translate/mutate; generated default freezes at creation |

## Function / Interface Checklist

- [ ] `SUPPORTED_LOCALES`: exact 55 Chrome directory codes, one source of truth.
- [ ] `RuntimeLocalePreference = 'system' | SupportedLocale` and locale metadata (`languageTag`, `direction`, display label strategy).
- [ ] `MessageKey`, `ChromeMessageEntry`, `ChromeMessageCatalog`, named substitution contract.
- [ ] Validator entry points for catalog schema, key parity, placeholders, manifest tokens, HTML/code references, quality metadata.
- [ ] Analyzer reads only explicit DOM markers, manifest tokens, and declared message-key registries; no general TS AST/regex parser.
- [ ] Stable action selectors for delete, duplicate, open-profile-tab, and theme interaction.
- [ ] Explicit create-name contract: `input.trim() || t('generatedSessionName', [index])`; stored `Session.name` unchanged thereafter.
- [ ] Duplicate contract accepts/resolves a localized suffix at creation; `duplicateSession` stores the resulting full name unchanged.

## Dependency Map

`English inventory → key/type contract → validator → stable selectors/runtime tests → Phase 2 adapter → Phase 3 surfaces → Phase 5 catalogs`.

## Implementation Steps

1. Enumerate all user-visible strings from reported paths; classify brand literal, translatable copy, storage/protocol identifier, or user data.
2. Define canonical keys and named placeholders. Include manifest-only keys and allowlist them from DOM-reference checks.
3. Add complete English messages and exact supported-locale metadata. Keep Chrome folder codes separate from BCP 47 document tags.
4. Implement validator failures: malformed objects, empty messages, invalid/reserved keys, missing/extra keys, placeholder drift/unused declarations, absent English/default locale, unknown explicit-marker/registry references, disallowed locale directories, unapproved bidi/default-ignorable controls, symlinks, non-regular files, and unexpected catalog-tree entries.
5. Add focused Vitest contract tests, including missing-key fallback expectations for Phase 2 and `ar/fa/he` direction metadata.
6. Add stable E2E action attributes to existing rendered controls; retain separate English baseline ARIA assertions until Phase 3 makes them locale-derived.
7. Add regression test proving existing saved names including literal `Session 1` and mixed-script text are not rewritten when locale changes.
8. Protect duplicate naming: localize `" (copy)"` only when the duplicate is created, pass it through the message/store contract, and prove subsequent locale switches preserve the full stored name.
9. Add table-driven tests for all 55 codes: folder code ↔ BCP 47 tag ↔ fallback/direction metadata ↔ selector value round trip.

## Test Scenario Matrix

| Scenario | Level | Expected |
|---|---|---|
| Canonical English complete | Validator/unit | All referenced/manifest keys resolve non-empty |
| Invalid/extra locale or key | Validator fixture | Deterministic failure with path/key |
| Placeholder reorder/parity | Unit | Named substitutions reorder safely; drift rejected |
| English-coupled actions | E2E focused | CRUD/open-tab/theme use stable actions; semantic labels still checked |
| Existing `Session 1`, `Work حساب`, URL/domain | Unit/E2E seed | Byte-for-byte unchanged after preference change |
| Empty create input | Unit contract | Localized default produced once at creation; later locale change does not alter it |
| Duplicate under `de`, then switch `ar` | Unit/integration | Localized persisted copy name remains byte-for-byte unchanged |
| All 55 locale metadata rows | Unit table | Folder/tag/fallback/direction/selector round trip is lossless |
| Bidi/default-ignorable catalog controls | Validator fixture | Rejected unless explicitly approved per key |
| Symlink/non-regular/unexpected catalog file | Validator fixture | Rejected before parsing/package copy |

## Todo List

- [x] Inventory and classify messages.
- [x] Create English catalog and contracts.
- [x] Add validator and package script.
- [x] Decouple action selectors.
- [x] Protect stored-name invariants.
- [x] Protect creation-time duplicate suffix.
- [x] Add all-55 metadata and catalog-file safety tests.
- [x] Run focused unit/E2E checks.

## Success Criteria

- [x] Every current user-visible string has a disposition and stable key where appropriate.
- [x] Validator catches schema/key/placeholder/reference/locale failures.
- [x] English catalog is complete; no translated protocol keys or user data.
- [x] Locale-independent actions pass; accessibility assertions remain meaningful.
- [x] Generated-name lifecycle is explicitly tested and immutable after storage.

## Risk Assessment

Main risk: incomplete inventory creates English leaks. Mitigate with static marker/reference scans plus a manual dynamic-string checklist. Stable selectors must not replace accessibility coverage; test both contracts.

## Security Considerations

Catalog values are text, never HTML. Placeholder tests include hostile `<>&` and bidi-control-like input; user values pass through `textContent`/DOM nodes unchanged. Do not expose cookies or imported payloads to catalogs.

## Next Steps

Proceed to Phase 2 only when English/validator/runtime seam tests pass. Rebase build work against `plans/260522-1335-bundle-size-reduction/` before editing shared scripts.
