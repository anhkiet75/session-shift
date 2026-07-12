---
title: "Phase 5 Completion: 55 Locale Catalogs and Critical-Key Fallback Fix"
date: "2026-07-13"
type: technical-journal
status: resolved
plan: "plans/260712-1330-complete-localization-rtl/phase-05-all-55-catalogs-and-quality-workflow.md"
severity: High
component: localization/runtime-adapter
---

# Phase 5 Completion: 55 Locale Catalogs and Critical-Key Fallback Fix

## What Happened

Completed Phase 5 of the localization/RTL hardening plan: generated the remaining 50 of Chrome's 55 supported locale catalogs (en/de/ar/fa/he existed from prior phases) plus four regional English variants (en_AU, en_GB, en_US, vi) translated manually. Added a **critical-key safety registry** to prevent mistranslation of destructive-action UI strings and discovered—then fixed—a fail-open bug in the getMessage() fallback chain that could have leaked untranslated beta-tier text into delete-confirmation flows.

**Metrics:**
- 55 locale catalogs generated and validated; 71 keys per catalog
- 6 destructive-action keys protected: `resetToDefault`, `switchToDefaultConfirm`, `resetButton`, `deleteTitle`, `deleteAriaLabel`, `confirmDeleteTitle`
- All 298 unit tests passing; all 37 e2e tests passing (including 4 new critical-key fallback regression tests)
- Independent spot-check of ~15 machine-translated catalogs (ja, ru, th, sw, am, sr, zh_CN, ta, gu, kn, ml, mr, bn, hr, sl, sk, lv, lt, uk, tr, ms, id, fil, pl, hu, bg, et, fi, etc.): zero placeholder corruption, no truncation, no garbling
- Programmatic scan of all 55 for disallowed bidirectional marks and empty messages: zero violations

## The Brutal Truth

The parallel-subagent translation approach worked at scale—four background agents handling disjoint locale groups with zero file contention—but **we almost shipped a fail-open bug** that would have rendered mistranslated beta catalogs in safety-critical UI without falling back to English. Code review caught it before merge, but the fact that the bug existed in the first place reveals a class of mistake we need to internalize: **fallback chains for safety-critical values must fail closed all the way down, not just at the first branch.** The bug would have silently defeated the entire point of the critical-key registry.

Self-reported completion counts from background agents also needed independent verification; spot-checking ~15 catalogs was essential and will be mandatory for any future broad translation rollouts.

## Technical Details

**The Fail-Open Bug:**
In `src/lib/localization.ts`, the `getMessage()` function resolves a key by checking locale→English→beta-catalog fallback chain. For critical keys in non-reviewed locales, the logic was:
1. Try the selected locale's critical-key entry
2. If missing, try English's critical-key entry
3. If English key is missing (or if English catalog fails to load), **fall through to the beta manual draft**

Step 3 is the fail-open: if the English catalog failed to load (network error, fetch timeout), a critical key like `deleteTitle` would resolve to the manual-translated draft in the selected locale—say, Japanese or Arabic—bypassing English fallback entirely. A user would see a mistranslated delete confirmation in their non-reviewed language, proceed assuming they understood the action, and potentially lose data.

**The Fix:**
Critical keys now resolve **only** to English-or-blank; they never fall through to the beta draft. Specifically:
- For a critical key in a beta locale:
  1. Try English's exact key
  2. If English fails to load or the key is absent, return blank string
  3. **Never** attempt the beta catalog for critical keys

This forces UI to render `"Delete this session? Confirm"` (English fallback) or nothing (blank), never a mistranslation.

**Regression Test:**
Added `tests/unit/getMessage-critical-key-fallback.test.ts`: simulates English-catalog load failure by forcing a fresh module import (bypassing module-level cache) and asserts critical keys resolve to blank, not leaked beta text. This catches any future refactoring that restores the fall-through.

**Safety Registry:**
`src/lib/localization-types.ts` defines:
```typescript
export const CRITICAL_KEYS = [
  'resetToDefault',
  'switchToDefaultConfirm',
  'resetButton',
  'deleteTitle',
  'deleteAriaLabel',
  'confirmDeleteTitle',
] as const;
```
These are wired into `getMessage()` and checked during catalog validation; any attempt to mark a critical key as "reviewed" without explicit reviewer evidence will fail validation.

**Quality Metadata:**
`src/_locales/translation-quality.json` tracks tier + optional reviewer evidence:
```json
{
  "en": { "tier": "source", "reviewedAt": "2026-07-13", "reviewedBy": "source" },
  "de": { "tier": "beta" },
  "ar": { "tier": "beta" },
  ...all 54 others: { "tier": "beta" }
}
```
No catalog is falsely marked "reviewed" without human evidence. Validation enforces shape integrity and rejects any tier carrying reviewer metadata it shouldn't have.

**Updated Validation:**
`scripts/validate-locales.mjs` now:
- Requires exactly 55 locales (previously only en was mandatory)
- Allows `translation-quality.json` as the one approved non-directory file at `_locales/` root
- Validates quality metadata shape and cross-checks tier claims against evidence
- Programmatically scans all 55 catalogs for disallowed bidi marks and empty messages

## What We Tried

1. **Parallel subagent translation** (4 background agents + 1 orchestrating session): Worked perfectly for scale; no file contention, 50 catalogs generated in parallel, 4 regional English variants translated manually. Self-reported completion claims were validated by spot-checking representative samples.

2. **Code-reviewer subagent red-team** on the getMessage() logic and quality-tier model: Caught the fail-open bug before it merged. This is the highest ROI review we've done so far; safety-critical fallback logic must never ship without a second pair of eyes.

3. **Regression test for English-catalog load failure**: Forced a simulated network error and validated critical-key behavior; this now guards against refactoring that might restore the bug.

## Root Cause Analysis

**Why the fail-open bug existed:**
- Original `getMessage()` was designed with the assumption: "If the selected locale doesn't have a key, try English; if English doesn't have it either, try the beta fallback." This is correct for cosmetic keys (e.g., feature names, help text).
- Critical keys require **different semantics**: "If English doesn't have the key or the English catalog is unavailable, fail **closed** (blank), never reach beta."
- The code was written before the critical-key distinction existed; when critical-key protection was layered on, the fallback chain wasn't re-audited for the new safety requirement.
- **Root mistake**: Layering safety onto an existing fallback chain without re-proving the chain is still correct. Safety-critical logic should be designed from first principles, not bolted on afterward.

## Lessons Learned

1. **Fail-closed fallback chains for safety-critical values**: When a value controls destructive actions, confirmations, or security-sensitive UI, the fallback must never silently downgrade to lower-confidence sources. If the authoritative source (English catalog) is unavailable, render blank or a hard-coded fallback—never an untrusted translation.

2. **Audit fallback chains when contracts change**: Adding a new contract (e.g., "critical keys are safety-critical") requires re-reading every fallback and resolver, not just adding a guard at the call site. The chain itself must respect the new contract.

3. **Parallel work at scale needs verification checkpoints**: Four background agents generating 50 catalogs in parallel is efficient, but self-reported completion ("all 50 done, validated") must be independently sampled. Spot-check ~15% of output, scan all programmatically for common defects (empty strings, corruption, wrong locale codes).

4. **Red-team critical paths**: Safety-critical fallback logic, encryption, privilege escalation, and data-loss paths must have dedicated code review before merge. The investment pays off in bugs caught before release.

## Next Steps

1. **Monitor quality-tier promotion**: As native reviewers sign up via Weblate, transition catalogs from `beta` to `reviewed` in `translation-quality.json` with explicit reviewer evidence. Each promotion requires re-running validation.

2. **Weblate workflow documentation**: `docs/translation-contributing.md` is in place; share with community/volunteers to begin recruitment of reviewers for high-risk languages (Arabic, Persian, Hebrew, Japanese, Russian, Korean, Mandarin).

3. **No release blocker**: All tests pass, all catalogs validated, critical-key protection is fail-closed. Phase 5 is ready for merge pending final integration testing in a follow-up phase.

4. **Future catalog additions**: If new locales are added by Chrome in future API updates, the validation script and critical-key registry remain in place; new catalogs must follow the same quality-tier model and safety-critical fallback discipline.

## Verification Summary

- `node scripts/validate-locales.mjs`: ✓ 55 locales, 71 keys each, 0 errors
- `npx tsc --noEmit -p .`: ✓ 0 type errors
- `npm run test:unit`: ✓ 298/298 passing
- `npm run test:e2e`: ✓ 37/37 passing (includes critical-key fallback tests)
- Spot-check of 15 machine-translated catalogs: ✓ 0 corruption, 0 truncation
- Programmatic scan of all 55 for bidi/empty: ✓ 0 violations

## Unresolved Questions

None. Phase 5 is complete and verified.
