---
date: 2026-07-12
session: complete-localization-rtl-decision
status: approved
source: ../../plans/reports/brainstorm-260712-1324-complete-localization-rtl.md
---

# Journal: 2026-07-12 — Complete Localization and RTL Decision

## Context

SessionShift needs understandable extension controls, feedback, accessibility text, and native surfaces across every Chrome-supported locale. The brainstorm evaluated native-only localization, a third-party runtime, and a small internal runtime adapter while preserving the vanilla TypeScript, MV3, offline, and dependency constraints.

## What Happened

- Approved Chrome `_locales` catalogs as the canonical translation source.
- Approved a dependency-free runtime adapter for `System default` and manual language selection, with complete English fallback.
- Defined production RTL behavior for Arabic, Persian, and Hebrew, including logical CSS and bidirectional isolation for user content.
- Established translation quality tiers, catalog validation, stable test selectors, and representative linguistic and visual QA.
- No implementation occurred: no code, catalogs, tests, build configuration, or product documentation changed during the brainstorm.

## Reflection

The hybrid approach fits Chrome's manifest localization model while covering its inability to switch `chrome.i18n.getMessage()` to a manually selected locale. The main remaining risk is translation quality at broad locale coverage, so catalog availability must remain distinct from human-reviewed status.

## Decisions

| Decision | Rationale | Impact |
|---|---|---|
| Use Chrome `messages.json` catalogs plus an internal runtime adapter | Supports native manifest localization and immediate extension-owned UI switching without a production dependency | One canonical catalog format; adapter, resolver, fallback, and validation work required |
| Keep English complete and canonical | Prevents blank or broken UI when localized messages are incomplete | Every message must resolve through English fallback |
| Persist `System default` or a manual locale | Chrome's UI locale may not match user preference | Popup, Options, and extension-controlled menus can switch at runtime |
| Treat manifest locale as Chrome-controlled | Chrome resolves manifest messages from its own UI locale | Manual preference cannot override extension name, description, or command descriptions |
| Apply RTL at document, layout, and mixed-content levels | Direction changes alone do not make complex UI safe | Requires logical CSS, selective icon mirroring, `dir="auto"` or `<bdi>`, and RTL QA |
| Label unreviewed catalogs as beta | Broad machine-generated coverage does not equal reliable translation | Human and visual review gates promotion to reviewed status |

## Next

- Create a detailed implementation plan from the approved brainstorm.
- Inventory user-facing strings, accessibility text, and directional CSS.
- Define localization keys and catalog validation before generating translations.
- Choose a translation platform and recruit native reviewers.

## Unresolved Questions

- Use Weblate or Crowdin for translation operations?
- Which native reviewers are available beyond English and Vietnamese?
