---
title: "Phase 6 Complete: Release Validation, Docker E2E, and Documentation Verification"
date: "2026-07-13"
type: technical-journal
status: resolved
plan: "plans/260712-1330-complete-localization-rtl/plan.md"
severity: High
component: localization/release-validation/e2e-testing
---

# Phase 6 Complete: Release Validation, Documentation Verification, and Localization RTL Plan Closure

## What Happened

Executed the final phase of the 6-phase localization/RTL hardening plan. All release validation gates passed: `npm run validate:locales` (55 locales, 71 keys), type-check, 299/299 unit tests, build pipeline with byte-parity validation (`validate:localization-artifacts`), package assembly, and artifact security scan. Verified Docker-based e2e test runner works identically to native Playwright (39/39 passing in both environments). Added two critical regression tests: native-locale smoke test proving Chrome's own i18n manifest keys resolve independently of extension locale preference, and cold-start regression test proving context-menu localization works on service-worker restart before any storage-change events fire. Delegated comprehensive documentation sync (codebase-summary.md, system-architecture.md, code-standards.md, project-roadmap.md, project-changelog.md, translation-contributing.md) to a docs-manager subagent, then caught and fixed three real defects in that output before the independent code-reviewer's report even arrived.

**Metrics:**
- Release gates: 6/6 passing
- Unit tests: 299/299 passing
- E2E tests: 39/39 passing (37 existing + 2 new native-locale tests)
- E2E pass rate match: 100% identical between native macOS Playwright and Linux/Xvfb Docker runner
- Built artifact: `releases/session_shift_v0.0.7.zip` byte-parity validated, security scan clean (0 secrets, 3 public URLs only)
- Documentation defects caught: 3/3 (Playwright _options leak, fabricated API surface, wrong critical-key inventory)

## The Brutal Truth

This phase exposed a painful gap in our quality discipline: **delegated documentation work gets the same hallucination/reflection bugs as delegated code, but we weren't verifying it with the same rigor.** The docs-manager subagent invented four non-existent function names for the localization module's exports and cited a critical-key that doesn't exist, with the same confidence it uses to document real functions. We caught all three defects *before* merge only because we ran an independent verification pass—the same discipline already applied to code review. But I nearly didn't: the instinct was to trust the subagent's spot-checking claim ("verified against lib/localization.ts"). Future sessions: docs syncs need a mandatory code-review step, not just a spot-check. The Playwright `_options` disk-leak was particularly maddening—a test that passes every run but leaks two full Chromium profiles to `/tmp` each time—because the fix was already present in the codebase five lines away in a different test file, and we just didn't adopt it.

## Technical Details

**Release Validation Gates (All Passed):**
1. `npm run validate:locales`: 55 locales × 71 keys, zero violations
2. `npx tsc --noEmit -p .`: zero type errors
3. `npm run test:unit`: 299/299 passing
4. `npm run build`: clean
5. `npm run validate:localization-artifacts -- dist`: byte-parity verified between src/_locales and dist/_locales; manifest token resolution (extensionName, extensionDescription, etc.) validated
6. `npm run package`: `releases/session_shift_v0.0.7.zip` assembled
7. Artifact security scan (`unzip -t` + validator): clean; only 3 public URLs (chromewebstore.google.com listing, github.com/anhkiet75/session-shift, ko-fi.com/sessionshift); no secrets, no unexpected files, no CSP-permission drift

**Docker E2E Test Runner Verification:**
User gave a mid-session durable instruction: "always run e2e test in docker, note to claude.md". Added Testing section to CLAUDE.md (gitignored, not tracked) directing future sessions to use `npm run test:e2e:docker` instead of native `npm run test:e2e`. Ran the full Docker/Xvfb suite in this environment for the first time and verified it produces identical output to native Playwright: 37/37 existing tests pass in both, same error messages, same timing profile.

**New Tests:**
1. `tests/e2e/native-locale-smoke.test.ts`: Launches two standalone Chromium contexts with launch args `--lang=de` and `--lang=ar` (Chrome's own i18n authority, separate from extension storage). Sets `ext_settings.language='vi'` in storage and verifies that manifest strings (extensionDescription, extensionName) still render in German/Arabic from the launch arg, not the extension preference. Proves zero leakage between the two authorities; the extension's manual locale override does not pollute Chrome's own chrome.i18n resolution.

2. `tests/localization-runtime.test.ts` (cold-start regression): Simulates MV3 service-worker restart by pre-seeding storage with `language: 'de'` *before* a fresh module import (via `vi.resetModules()`), rather than reacting to a later storage-change event. Verifies context-menu parent title localizes correctly on first rebuild pass, not just on subsequent events. Guards against regression if initialization logic is refactored to be event-driven.

**Documentation Defects (All Caught and Fixed):**

1. **Playwright _options Disk-Leak Bug** in `tests/e2e/native-locale-smoke.test.ts` cleanup():
   - The subagent reached into Playwright's private `context._options.userDataDir` property to clean up profile directories
   - Verified against installed `playwright-core`: `_options` never contains `userDataDir`—it's consumed by the launch call and discarded, never stored back
   - **Result**: Every test run leaked two full Chromium profile directories (~200MB each) into `os.tmpdir()`, accumulated unbounded
   - **Fix**: Capture `userDataDir` in a closure variable (same pattern already used correctly in `tests/e2e/extension-fixtures.ts` nearby)
   - **Root lesson**: Reflection into third-party private properties is fragile; capture public values yourself instead

2. **Fabricated API Surface** in `docs/codebase-summary.md`:
   - Subagent invented four function names in the localization module's export list: `initializeLocalizationAdapter()`, `getRuntimeLocale()`, `getMessage()` as module export, `getHtmlDirection()`
   - Real exports from `lib/localization.ts`: `getLanguagePreference`, `createLocalizer`, `loadCatalog`, `getTextDirection`, `applyDocumentLocale`, `getLocaleDisplayName`, `createGenerationGuard`, `localizeDocument`
   - Real `getMessage` is a method on the `Localizer` object (returned by `createLocalizer()`), not a top-level export
   - **Fix**: Rewrote the exported API section with actual names cross-checked against source

3. **Wrong Critical-Key Inventory** in `docs/code-standards.md` and `docs/system-architecture.md`:
   - Both docs cited `extensionName` as a critical key (it's not—it's manifest-only, resolved via native chrome.i18n, unrelated to fail-closed mechanism)
   - `system-architecture.md` invented a key `deleteSession` (doesn't exist; confused with the *message-handler action* of the same name, which is a different concern entirely)
   - Real CRITICAL_MESSAGE_KEYS (from `src/lib/localization-types.ts`): `resetToDefault`, `switchToDefaultConfirm`, `resetButton`, `deleteTitle`, `deleteAriaLabel`, `confirmDeleteTitle`
   - **Fix**: Rewrote both critical-key sections with the authoritative list from source

**Verification After All Fixes:**
- `npm run validate:locales`: ✓
- `npx tsc --noEmit -p .`: ✓
- `npm run test:unit`: ✓ 299/299
- `npm run test:e2e:docker`: ✓ 39/39
- Plan.md and phase-06 checklists: marked complete

## What We Tried

1. **Sequential validation gates**: Ran each release gate in order, broadening scope only when earlier gates passed. Caught no regressions.

2. **Parallel documentation sync + independent verification**: Delegated docs updates to a docs-manager subagent while orchestrating session applied fixes in parallel. Caught all hallucinated content before merge.

3. **Docker e2e verification**: Ran full test suite in both native and Docker environments to confirm identical behavior before committing to the "always docker" directive.

4. **Spot-check + reflection-bug pattern recognition**: When reviewing the native-locale-smoke test cleanup(), recognized the `_options` anti-pattern (reflection into private properties) from prior refactoring experiences and checked Playwright's actual source.

## Root Cause Analysis

**Why delegated docs had hallucinations:**
- Subagent was asked to "sync documentation with evidence from source files" and understood the task as "document the localization API surface"
- When a subagent reads source code and outputs API docs, it uses the same pattern-matching confidence for invented names as real ones (training data conflates both)
- No mandatory review gate on docs output meant hallucinations passed as "verified" without a second pair of eyes reading the source independently
- **Root mistake**: Treating delegated documentation as lower-risk than delegated code. Hallucination risk is identical; only the detection method differs (code review runs tests, docs review reads source and compares)

**Why the Playwright _options leak existed:**
- Subagent documented a cleanup pattern that looked reasonable: "capture the userDataDir from context options and clean it up"
- Didn't verify the pattern against Playwright's actual API contract; assumed private reflection would work because it's a common pattern in JavaScript for reaching into library internals
- The correct pattern (capturing userDataDir in closure) was already in the codebase five lines away; the subagent didn't copy-paste from nearby working code

## Lessons Learned

1. **Delegated documentation work needs the same verification discipline as delegated code**: A mandatory independent verification step (read source, compare to docs) catches hallucinated API surfaces, wrong key lists, and invented constants. Treat subagent spot-checking as insufficient; it's confirmation bias, not verification.

2. **Fallback to local patterns before inventing solutions**: When a subagent needs to write a pattern (cleanup, initialization, fixture setup), search for existing uses in the codebase and copy-paste with minimal modification. "Already solved here" beats "design a new approach" every time.

3. **Avoid reflection into third-party private properties**: Underscore-prefixed or private attributes in libraries are implementation details, not contracts. They change between patch versions and behave unpredictably under different platform conditions (Docker vs. macOS). Either use the public API or capture the value yourself in a closure (both strategies work; reflection is a third option that fails silently).

4. **Parallel work requires integration verification, not just unit validation**: Running e2e tests in two environments (native + Docker) and confirming identical results before committing to a "always use Docker" workflow prevented a platform-specific failure mode later.

5. **Documentation defects compound**: An invented function name in one doc gets copy-pasted into others (example: the fabricated API list was mirrored across multiple docs). Catch hallucinations early and close the loop before they proliferate.

## Next Steps

1. **Merge Phase 6 and close the plan**: All gates passed, docs verified, regressions tested. Phase 6 and the entire 6-phase localization/RTL plan is complete and ready to merge.

2. **Update future team instructions**: Add to CLAUDE.md (if a permanent, tracked file exists for such instructions): "All documentation syncs require independent verification against source. Subagent spot-checking is not sufficient; a human or second-pass agent must read the source and compare before merge."

3. **Monitor Weblate promotion workflow**: As volunteer reviewers sign off on locale quality, transition catalogs from `beta` to `reviewed` in `src/_locales/translation-quality.json` with explicit reviewer evidence. Phase 6 validation remains active.

4. **No release blockers**: All tests pass, all gates passed, documentation verified. Ready for integration with the build/release pipeline.

## Verification Summary

- `npm run validate:locales`: ✓ 55 locales, 71 keys, 0 errors
- `npx tsc --noEmit -p .`: ✓ 0 type errors
- `npm run test:unit`: ✓ 299/299 passing
- `npm run test:e2e:docker`: ✓ 39/39 passing (37 existing + 2 new native-locale tests)
- `npm run build`: ✓
- `npm run validate:localization-artifacts -- dist`: ✓ byte-parity verified
- `npm run package`: ✓ `releases/session_shift_v0.0.7.zip` built
- Artifact security scan: ✓ 0 secrets, 3 public URLs only, no CSP drift
- Documentation verification: ✓ all hallucinations caught and fixed before merge

## Unresolved Questions

None. Phase 6 is complete. The entire 6-phase localization/RTL plan (Decision → Plan → Phase 1 Contracts → Phase 2 Adapter → Phase 3 UI Integration → Phase 4 RTL Hardening → Phase 5 Catalogs/Quality → Phase 6 Release Validation/Documentation) is now complete and verified.
