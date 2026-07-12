# Translation contributing & promotion workflow

`src/_locales/` ships exactly Chrome's current 55 supported locales
(`src/lib/locale-data.json` is the single source of truth for the allowlist).
Catalog **presence** means a locale is selectable and packaged — it does not
mean human-reviewed. Review state is tracked separately in
`src/_locales/translation-quality.json`.

## Quality tiers

`translation-quality.json` records exactly one entry per supported locale:

| Tier | Meaning |
|---|---|
| `source` | English only — the canonical, hand-authored text. Not a translation. |
| `beta` | Machine/community-drafted, mechanically valid (key/placeholder parity, no blank strings), **not** linguistically reviewed. |
| `reviewed` | A native reviewer approved parity and critical-copy wording. Requires a non-null `reviewer` and `reviewedAt` (ISO date) — the validator rejects a `reviewed` claim without both. |

A locale never appears as `reviewed` without recorded evidence. Beta is the
honest default and is not a defect — it just means "sanity-check before you
trust the exact wording."

## Critical-key fallback

`translation-quality.json`'s `criticalKeys` array names the destructive/
security-adjacent message keys (`resetToDefault`, `switchToDefaultConfirm`,
`resetButton`, `deleteTitle`, `deleteAriaLabel`, `confirmDeleteTitle`). At
runtime (`src/lib/localization.ts`), a beta locale renders these exact keys in
**English**, not the machine draft, until the key is added to that locale's
`criticalKeyEligible` list or the locale is promoted to `reviewed`. Decorative
copy is unaffected — it renders the local-language draft immediately, beta or
not.

This means: every locale is selectable and mostly localized as soon as its
catalog lands, but a mistranslated "Delete" confirmation can never reach a
user before a human has actually looked at it.

## Contribution/review platform: Weblate

Weblate is the selected tool for external contribution and linguistic review.
It is **development tooling only**:

- Not a runtime or build dependency — the extension never calls out to
  Weblate or any translation service at runtime (see
  `docs/security-audit-report.md` for the no-network-calls constraint).
- Not packaged in the shipped `.zip` — only `src/_locales/*/messages.json`
  and `src/_locales/translation-quality.json` ship.
- Configuration/credentials for the Weblate project (API tokens, component
  config) live outside this repository (in the maintainer's Weblate instance
  settings), never committed here.

### Round-trip process

1. **Export**: `src/_locales/en/messages.json` is the frozen source catalog.
   Any key addition/removal goes through English first, then the validator
   (`node scripts/validate-locales.mjs`) fails other locales for
   missing/extra keys until they catch up — this is deliberate churn control.
2. **Translate/review in Weblate**: contributors work per-locale against the
   English source. Weblate preserves each key's `description` field (shown
   only in English, as translator context) and enforces that translators
   never touch `$placeholder$` tokens.
3. **Import**: pull the translated strings back into
   `src/_locales/<locale>/messages.json`, preserving valid Chrome
   `{ "message": ..., "placeholders": {...} }` JSON shape. `description` is
   omitted from non-English catalogs (English-only, not shown in the UI).
4. **Validate**: `node scripts/validate-locales.mjs` must pass — key parity,
   placeholder parity, UTF-8, no blank messages, no unapproved bidi/
   default-ignorable control characters, tree safety (no symlinks/extra
   files).
5. **Promote**: a locale (or an individual critical key) only moves off
   `beta` after all of:
   - Reviewer identity + date recorded in `translation-quality.json`.
   - Critical-copy approval — every `criticalKeys` entry explicitly checked
     by the reviewer for correct destructive/confirm semantics.
   - Mechanical parity (step 4) passing.
   - Screenshot evidence for at least the representative visual/RTL matrix
     (see `tests/e2e/localization-rtl.test.ts`) if the locale changes layout
     direction, script, or causes text expansion in critical flows.

## Priority order for review

1. Destructive confirmations and delete/reset wording (the `criticalKeys`
   set) — these gate a locale's critical-key eligibility independent of the
   rest of the catalog.
2. Privacy/security-adjacent copy (currently none beyond the critical set;
   revisit if new destructive flows are added).
3. Settings descriptions and manifest/command descriptions (shown in
   `chrome://extensions` and the keyboard-shortcuts page).
4. Decorative/informational copy (empty states, taglines, links).

## Adding a new locale after a future Chrome allowlist change

1. Re-confirm the change against Chrome's own supported-locale
   documentation (primary source) — do not add/remove a code on inference.
2. Update `src/lib/locale-data.json` and the matching literal in
   `src/lib/localization-types.ts` (`SUPPORTED_LOCALES`, and `RTL_LOCALES` if
   the new locale is RTL) together — they must stay byte-for-byte in sync
   (enforced by `tests/localization-catalog.test.ts`).
3. Add `src/_locales/<code>/messages.json` and a `beta` entry in
   `translation-quality.json` before the validator or tests will pass.

---

## Release Checklist: Chrome Web Store Localization

**Important:** The `src/_locales/*/messages.json` catalogs **only control which locales are selectable within the extension itself**. They do **not** automatically localize the Chrome Web Store listing page (title, description, screenshots, promotional tiles). Store localization is separate work via the CWS developer dashboard.

### Before Claiming a Locale Is Supported in CWS

For each locale you plan to publish as "supported":

1. **Verify catalog exists**
   - [ ] `src/_locales/<code>/messages.json` exists and passes `npm run validate:locales`
   - [ ] Locale is in `translation-quality.json` (at minimum as `beta`)

2. **Translate the store listing** (per locale in CWS dashboard)
   - [ ] Store title localized (if different from English)
   - [ ] Store description localized (1-line summary + full description)
   - [ ] Promotional tiles/screenshots updated with legible localized text (if UI text is visible)
   - [ ] If the locale is RTL, screenshots show RTL rendering clearly

3. **Promotion tier in catalog** (check `translation-quality.json`)
   - [ ] Claim `beta` if only extension UI is available (you haven't translated store copy yet)
   - [ ] Claim `reviewed` **only if**:
     - Native speaker has approved all extension UI wording AND
     - Store listing copy is also localized and reviewed AND
     - `translation-quality.json` records reviewer name + review date (`reviewedAt`)

4. **Avoid overstating quality**
   - [ ] Never use store copy like "We support 55 locales in 100% native quality" if only `beta` tiers exist — that's false
   - [ ] Use "Available in [55 languages](link-to-docs)" or "Select from 55 locales; English and reviewed languages highlighted"
   - [ ] Link to `docs/translation-contributing.md` or equivalent public-facing FAQ so users understand the difference

### Quality Tier Example
- **Beta (e.g., Spanish-Mexico es_419):** Extension UI is machine-translated + mechanically valid, CWS store listing is in English only → "Selectable in the extension; English store listing" or "Beta locale"
- **Reviewed (e.g., English en):** All extension UI hand-authored, store listing localized and reviewed → "Native language support" or "Reviewed"
