---
title: "Complete Chrome Localization and RTL"
description: "Add Chrome-native System localization, packaged manual language selection, English fallback, 55 catalogs, and production RTL without changing user data."
status: complete
priority: P1
branch: "0.0.7"
tags: [feature, frontend, accessibility, localization]
blockedBy: []
blocks: []
created: "2026-07-12"
createdBy: "ck:plan"
source: skill
---

# Complete Chrome Localization and RTL

## Overview

Localize every extension-owned surface for Chrome's current 55 extension locales. System mode delegates locale selection to Chrome; a stored manual override switches popup, Options, and context menus immediately. English is canonical fallback. Arabic, Persian, and Hebrew receive production RTL/bidi hardening. User-created and imported values remain byte-for-byte unchanged.

## Phases

| Phase | Name | Status |
|---|---|---|
| 1 | [Localization contracts and regression seams](./phase-01-localization-contracts-and-regression-seams.md) | Complete |
| 2 | [Runtime adapter, settings, build, and package](./phase-02-runtime-adapter-settings-build-and-package.md) | Complete |
| 3 | [Localize all extension surfaces](./phase-03-localize-all-extension-surfaces.md) | Complete |
| 4 | [RTL and bidirectional hardening](./phase-04-rtl-and-bidirectional-hardening.md) | Complete |
| 5 | [All 55 catalogs and quality workflow](./phase-05-all-55-catalogs-and-quality-workflow.md) | Complete |
| 6 | [Release validation and documentation](./phase-06-release-validation-and-documentation.md) | Complete |

## Dependencies

- Sequential: `1 → 2 → 3 → 4 → 5 → 6`; Phase 2 must seed validated `de/ar/fa/he` catalogs before Phase 3/4 tests.
- No formal cross-plan dependency. Before Phase 2, inspect/rebase against `plans/260522-1335-bundle-size-reduction/`; it edits `scripts/build.sh` and static assets. Preserve its minification/compression work and add `_locales` copy/package validation to the resulting pipeline.
- Before Phases 3–4, reconcile stale popup plans that touch the same modules/CSS; current source is authoritative. Do not reimplement already-landed color/delete behavior.

## Acceptance Criteria

- System plus all 55 locales selectable; manual changes immediately update extension-owned UI and context menus; English prevents blank text.
- Chrome-owned manifest/command surfaces follow Chrome UI locale only; manual-selection limitation is visible in docs and tests.
- `ar`, `fa`, `he` render RTL; mixed-direction names, domains, URLs, versions, shortcuts, and numbers remain readable.
- Existing user data is never translated or rewritten. Generated `Session N` and duplicate `" (copy)"` suffixes are localized only at creation, then stored and preserved byte-for-byte.
- Locale, placeholder, reference, type, unit, representative E2E/visual, build, and ZIP integrity gates pass with no production dependency.
- Catalog availability and linguistic review status remain separate; only verified locales may be called reviewed.

## Red Team Review

| Disposition | Count | Applied scope |
|---|---:|---|
| Accepted | 14 | Representative catalogs early; serialized settings writes; async last-write-wins; coalesced menus; clean dev copy; creation-time duplicate suffix; critical-key English fallback; all-55 round trips; catalog control/file safety; no-flash reveal; one artifact command; exact manual fallback; explicit-marker analyzer |
| Rejected | 2 | No cryptographic/CODEOWNERS attestation; no profile-name spoof/immutable-ID expansion |

## Validation Log — Session 1 (2026-07-12)

| Question | Options | Answer |
|---|---|---|
| Which translation platform should the workflow use? | Weblate; Crowdin | Weblate |
| Where should language preference be stored? | Existing `chrome.storage.local` `ext_settings`; cross-device sync | Existing local `ext_settings`; no sync in scope |

- Confirmed: Phase 2 owns local preference persistence; Phase 5 owns Weblate workflow; Phase 6 documents/releases those exact contracts.
- Full-tier verification: prior red-team evidence gate existed; all accepted/rejected dispositions remained represented; no `[UNVERIFIED]` tags remained.

## Execution Notes

- Use `textContent`, DOM construction, allowlisted packaged paths, and the serialized field-level `ext_settings` mutator.
- Run focused checks first, then `npm run validate:locales`, `npm run type-check`, `npm run test:unit`, `npm run build`, headed `npm run test:e2e`, and `npm run package` as phases broaden.
- Documentation changes occur only in Phase 6 after behavior and release claims are verified.

## Validation Whole-Plan Consistency Sweep

- Files reread: `plan.md` and all six `phase-*.md`; Weblate/local-storage decisions propagated; prior 14 red-team deltas retained.
- Searches covered stale Crowdin, cross-device sync, open-question, fallback, sequencing, and validation contradictions.
- Unresolved contradictions: none.
- Operational constraint: native reviewers beyond English/Vietnamese remain unidentified; affected catalogs remain beta, not a decision blocker.
