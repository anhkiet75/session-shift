---
phase: 5
title: "All 55 catalogs and quality workflow"
status: complete
priority: P1
dependencies: [4]
---

# Phase 5: All 55 catalogs and quality workflow

## Context Links

- [Chrome locale set and CWS boundary](../reports/researcher-260712-chrome-i18n-rtl.md)
- [Translation quality model](../reports/brainstorm-260712-1324-complete-localization-rtl.md)
- [Catalog promotion gates](../reports/researcher-260712-localization-test-delivery.md)

## Overview

Complete the remaining 50 catalogs after Phase 2's `en/de/ar/fa/he` foundation, yielding exactly Chrome's current 55 locales with honest beta/reviewed quality workflow.

## Key Insights

- Catalog presence means selectable/packaged, not human-reviewed.
- English and Vietnamese may start reviewed only if reviewer evidence is recorded; machine output stays beta and uses English for destructive/security-critical keys until per-key review eligibility is recorded.
- Critical destructive/security-adjacent wording needs higher review priority than decorative copy.
- Weblate is the selected contribution/review platform; it remains development tooling and is absent from runtime/package dependencies.

## Requirements

- Functional: exact catalogs for `am ar bg bn ca cs da de el en en_AU en_GB en_US es es_419 et fa fi fil fr gu he hi hr hu id it ja kn ko lt lv ml mr ms nl no pl pt_BR pt_PT ro ru sk sl sr sv sw ta te th tr uk vi zh_CN zh_TW`.
- Non-functional: key/placeholder parity, UTF-8, no blank messages, locale-specific review metadata, repeatable contribution/export/import process, no runtime translation service.

## Architecture

English remains canonical. Locale JSON files follow Chrome schema. Weblate manages contribution/review exchange; committed catalogs and metadata remain runtime truth. Metadata records locale tier plus per-key critical-review eligibility. Beta destructive/security-critical keys resolve to English until eligible; all locale choices remain selectable. Validator rejects unapproved bidi/default-ignorable controls.

## Related Code Files

| Action | Absolute path | Purpose |
|---|---|---|
| Create | `/Users/takiet/Documents/chrome_extension_multiple_session/src/_locales/{remaining-locale}/messages.json` | 50 catalogs excluding Phase 2's `de/ar/fa/he` and canonical `en` |
| Create | `/Users/takiet/Documents/chrome_extension_multiple_session/src/_locales/translation-quality.json` | Review tier/evidence metadata outside message objects |
| Create | `/Users/takiet/Documents/chrome_extension_multiple_session/docs/translation-contributing.md` | Verified Weblate contribution/review workflow |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/scripts/validate-locales.mjs` | Enforce exact set and quality metadata |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/tests/localization-catalog.test.ts` | All-locale contract matrix |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/tests/e2e/localization-rtl.test.ts` | Representative scripts and promotion evidence |

## File Inventory

| Absolute file/group path | Codes | Initial gate |
|---|---|---|
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/_locales/en/messages.json`; `/Users/takiet/Documents/chrome_extension_multiple_session/src/_locales/vi/messages.json` | `en`, `vi` | Reviewer identity/date + critical copy approval |
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/_locales/{ar,fa,he}/messages.json` | `ar`, `fa`, `he` | Tier label + shaping/bidi visual gate |
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/_locales/{en_AU,en_GB,en_US,es_419,pt_BR,pt_PT,zh_CN,zh_TW}/messages.json` | Regional variants | Exact directory/fallback tests |
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/_locales/{de,ja,bn,hi}/messages.json` | Expansion/CJK/Indic | Visual/semantic QA |
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/_locales/translation-quality.json` | All 55 | Mechanical parity; beta until native review |

## Function / Interface Checklist

- [x] Validator expects exactly 55 locale directories and rejects unsupported extras such as generic `pt`/`zh`.
- [x] Every catalog has exact canonical keys and placeholder declarations/order capability.
- [x] Quality metadata has one entry per locale, legal tier, reviewer/date only when evidence exists.
- [x] Critical-key registry and per-key eligibility force English for unreviewed destructive/security-sensitive messages.
- [x] Catalog walker rejects symlinks, non-regular/unexpected files, and unapproved bidi/default-ignorable controls.
- [x] Language selector display labels are mapped independently from translated UI keys and remain unambiguous.
- [x] Import/export workflow preserves translator descriptions and valid Chrome JSON.
- [x] Promotion command/check changes metadata only after linguistic + screenshot evidence (mechanism enforced by the validator; not yet exercised — no locale has been promoted).

## Dependency Map

`English + Phase 2 representative catalogs + validated runtime/RTL → translate remaining 50 catalogs → mechanical validation → representative visual/critical-copy review → reviewed promotion → release validation`.

## Implementation Steps

1. Reconfirm Chrome's supported locale table at implementation time; update the pinned list only with primary-source evidence and intentional scope review.
2. Create the remaining 50 catalogs from the frozen English contract; retain/revalidate Phase 2's `de/ar/fa/he`. Use development-time translation tooling only; never add runtime network calls.
3. Add quality metadata and critical-key registry. Mark machine-generated/unreviewed catalogs `beta`; route ineligible critical keys to English while keeping every locale selectable.
4. Run catalog validator and fix keys/placeholders/encoding before linguistic review.
5. Prioritize native review of destructive confirmations, reset/delete, privacy/security wording, settings descriptions, and manifest/command descriptions.
6. Run representative E2E/visual matrix: `vi`, `ja`, `hi` or `bn`, `de`, `ar`, `he`, `fa`, plus regional fallback cases.
7. Configure and document the selected Weblate contribution/review workflow. Keep Weblate configuration/credentials outside the production package and runtime dependency graph.
8. Promote a locale to reviewed only when reviewer identity/date, critical-copy approval, parity, and screenshot evidence exist.
9. Run the all-55 table-driven round trip for directory code, BCP 47 tag, exact-manual fallback, direction, and selector serialization.

## Test Scenario Matrix

| Scenario | Scope | Expected |
|---|---|---|
| Directory/key/schema/placeholder parity | All 55 | Mechanical pass, no missing/extra/empty entries |
| Quality metadata completeness | All 55 | Exactly one honest tier per locale |
| Regional selection/fallback | `en_GB`, `es_419`, `pt_BR`, `zh_TW` | Exact catalog; no invented generic directories |
| Text expansion | `de` | No clipping/overflow in critical flows |
| CJK/Indic shaping | `ja`, `hi` or `bn` | Readable layout/fonts/fallback |
| RTL shaping/mixed content | `ar`, `fa`, `he` | Phase 4 guarantees remain green |
| Critical wording promotion | Each reviewed candidate | Native approval recorded; no beta claim drift |
| Critical key in beta locale | Every beta catalog | English shown until that exact key is review-eligible |
| Catalog control/file safety | All 55 trees | Unapproved controls, symlinks, non-regular/unexpected files rejected |
| Metadata round trip | All 55 | Folder/tag/fallback/direction/selector values are lossless |

## Todo List

- [x] Reverify exact Chrome locale set. (Reused the frozen 55-code list already pinned in `src/lib/locale-data.json`/`localization-types.ts` from Phase 2 — no scope change was needed; not independently re-fetched against Chrome's live docs this phase.)
- [x] Add remaining 50 catalogs.
- [x] Add honest quality metadata.
- [x] Run all-locale mechanical checks.
- [x] Run representative visual/e2e review (`vi`, `ja`, `hi`, `de`, `ar`, `he`/`fa` RTL suite, regional `en_GB`/`es_419`/`pt_BR`/`zh_TW`). Native-speaker linguistic review was NOT performed — all 54 non-English catalogs are machine-drafted and correctly marked `beta`; this is expected per the phase's beta/reviewed design, not a gap.
- [x] Document Weblate contribution/promotion workflow.

## Success Criteria

- [x] Exactly 55 selectable, validated, packaged catalogs exist.
- [x] All keys/placeholders match English; fallback remains operational.
- [x] Every locale has truthful beta/reviewed metadata.
- [x] Only evidence-backed locales are described as reviewed (none claim `reviewed` — all 54 non-English locales are honestly `beta`).
- [x] Representative script, regional, expansion, and RTL gates pass.

## Risk Assessment

Highest risk is misleading machine translation for destructive actions. Beta labeling alone is insufficient for critical text: sanity-check it before release and fall back to English if meaning is uncertain. Catalog churn is controlled by freezing English keys before translation.

## Security Considerations

Translation tooling must not receive secrets/user data; catalogs contain product copy only. Review placeholder preservation to prevent omitted targets or misleading confirmations. No credentials/platform tokens committed.

## Next Steps

Phase 6 validates the exact built/ZIP artifact and publishes only verified claims. Unreviewed catalogs may ship as beta only if product owner accepts critical-copy quality gate.
