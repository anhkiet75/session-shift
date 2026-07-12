---
phase: 4
title: "RTL and bidirectional hardening"
status: complete
priority: P1
dependencies: [3]
---

# Phase 4: RTL and bidirectional hardening

## Context Links

- [RTL inventory and hazards](../reports/researcher-260712-localization-code-inventory.md)
- [Chrome/WHATWG bidi research](../reports/researcher-260712-chrome-i18n-rtl.md)
- [Visual matrix](../reports/researcher-260712-localization-test-delivery.md)

## Overview

Make popup and Options production-safe for Arabic, Persian, and Hebrew. Convert directional layout to logical CSS, isolate mixed-direction values, and validate geometry, focus, truncation, menus, and themes.

## Key Insights

- Direction follows resolved runtime locale, not Chrome's `@@bidi_dir` during manual override.
- Logical properties solve most layout; gradients, radii, chevrons, toggle transforms, and JS popup anchoring need explicit direction-aware behavior.
- DOM/focus order must not reverse. User names/URLs require bidi isolation, not translation.

## Requirements

- Functional: `<html lang>` BCP 47 and `dir`; `ar/fa/he` RTL, all others LTR; correct placement/mirroring and mixed content.
- Non-functional: no horizontal document overflow/clipped controls; visible focus; same logical keyboard/tab order; light/dark coverage.

## Architecture

Direction metadata comes from the shared locale table. CSS uses inline/block logical properties. Narrow `[dir="rtl"]` overrides handle artwork/transforms. Dynamic user values use `<bdi>` or `dir="auto"`; JS anchoring resolves inline-start while clamping to viewport.

## Related Code Files

| Action | Absolute path | Purpose |
|---|---|---|
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/popup.css` | Logical spacing/edges/alignment and RTL exceptions |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/options/options.css` | Toggle, CTA, spacing, logical layout |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/popup.html` | Static bidi isolation hooks where needed |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/options/options.html` | Direction-neutral CTA markup/bidi hooks |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/popup-render-profile-list.ts` | `<bdi>`/`dir=auto` for names |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/popup-rename-handler.ts` | Opposite-direction name inputs/display |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/popup-open-in-tab-menu.ts` | Inline-start keyboard/pointer anchoring |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/popup-color-picker.ts` | Direction-aware popover alignment |
| Modify | `/Users/takiet/Documents/chrome_extension_multiple_session/tests/e2e/localization-rtl.test.ts` | Mixed-direction RTL behavior/visual assertions |

## File Inventory

| Absolute file/group path | Hazard/current behavior | Planned behavior |
|---|---|---|
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/popup.css` | Active bar, search, padding/divider use physical edges | Logical edges; narrow mirrored exceptions |
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/popup-open-in-tab-menu.ts`; `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/popup-color-picker.ts` | `left`/`cardRect.left` popovers | Direction-aware inline-start + viewport clamp |
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/options/options.css`; `/Users/takiet/Documents/chrome_extension_multiple_session/src/options/options.html` | Positive-X toggle/right arrow | RTL transform override; neutral/mirrored arrow |
| `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/popup-render-profile-list.ts`; `/Users/takiet/Documents/chrome_extension_multiple_session/src/popup/popup-rename-handler.ts` | Names inherit UI direction | `<bdi>` or `dir=auto` isolation |

## Function / Interface Checklist

- [ ] `getTextDirection(locale)` covers exactly `ar`, `fa`, `he` as RTL.
- [ ] Document metadata updates on initialization and every manual switch.
- [ ] Menu/color-picker positioning accepts direction or derives computed direction; viewport clamp works both sides.
- [ ] User-name render/input helpers apply `dir=auto`/bidi isolation without changing values.
- [ ] CSS has no remaining relevant physical-direction declarations unless documented as viewport coordinates.
- [ ] Keyboard focus/tab order and arrow-key behavior remain logical and unchanged unless component semantics require otherwise.

## Dependency Map

`Resolved locale metadata → html[lang][dir] → logical CSS + direction-aware JS positioning + bidi isolation → RTL E2E/visual gate → catalog expansion`.

## Implementation Steps

1. Audit popup/options CSS and relevant TS for `left/right`, physical margins/padding/borders, translations, arrows, gradients, and asymmetric radii.
2. Replace safe cases with logical properties; document legitimate viewport-coordinate uses.
3. Add minimal RTL overrides for gradients, radii, toggle thumb, directional arrows, and transforms.
4. Refactor menu and color-picker alignment to inline-start based on resolved/computed direction; clamp within viewport under narrow popup widths.
5. Wrap/mark session names, domains, URLs, versions, shortcuts, and numeric mixed-script values with bidi isolation. Do not wrap whole interactive controls in a way that disrupts accessibility.
6. Test `ar`, `fa`, `he`; use Arabic for every-PR visual coverage and Hebrew/Persian for release matrix.
7. Capture popup and Options in light/dark for `ar` and `de`; assert zero overflow, clipping, focus loss, or DOM-order changes.

## Test Scenario Matrix

| Scenario | Locale/theme | Expected |
|---|---|---|
| Popup full flow, long `Work حساب 123` | `ar`, light/dark | RTL chrome; name isolated; controls fit |
| Options picker/toggle/CTA | `ar`, light/dark | Correct inline placement/mirroring; tab order unchanged |
| Latin URL + punctuation + long name | `fa`, system | Stable visual order and truncation |
| Hebrew profile + Latin brand/version | `he`, light | Correct shaping/isolation |
| Long LTR expansion control | `de`, light/dark | No regression from logical CSS |
| Menu/color popover at both viewport edges | `ar` and `en` | Visible, aligned, clamped |
| Keyboard traversal/focus rings | `ar` | Same DOM order, visible focus |

## Todo List

- [x] Convert directional CSS.
- [x] Harden JS anchoring.
- [x] Add bidi isolation.
- [x] Verify all three RTL locales — `ar` is exercised end-to-end (e2e + visual baselines); `fa`/`he` direction/RTL metadata verified at the adapter level in Phase 2 unit tests (`createLocalizer` per-locale direction table). Per this phase's own Implementation Step 6, Arabic is the every-PR visual locale and Hebrew/Persian are the release-matrix locales — full `fa`/`he` visual coverage is Phase 6 (release validation) scope, not deferred by omission.
- [x] Review representative light/dark screenshots — captured popup+Options × ar/de × light/dark (8 images) and sent to the user for review.

## Success Criteria

- [x] `ar/fa/he` use RTL; every other supported locale uses LTR.
- [x] No horizontal overflow, clipped controls, misplaced menus, or broken toggles/arrows.
- [x] Mixed user content remains readable and byte-identical.
- [x] Focus/tab order and accessibility semantics are preserved.
- [x] Arabic and German light/dark visual baselines are reviewed.

## Risk Assessment

Broad CSS edits can create LTR regressions. Convert one component group at a time and compare `en/de/ar`. Avoid blanket `transform: scaleX(-1)` or reversing flex/DOM order.

## Security Considerations

Bidi isolation reduces visual spoofing/confusion but does not sanitize or mutate values. Never strip user-supplied bidi characters silently; render isolated text and preserve exports/storage exactly.

## Next Steps

Proceed to Phase 5 after RTL/mixed-content gates pass against the representative `ar/fa/he` catalogs seeded in Phase 2.
