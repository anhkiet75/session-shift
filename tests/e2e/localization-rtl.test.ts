import { test, expect, seedLocalePreference } from './extension-fixtures'

// Baseline surface-switching/completeness coverage for Phase 3 (English +
// System + one representative manual locale). Phase 4 adds RTL-specific
// mixed-direction, layout, positioning, and focus-order assertions below.

test.describe('Options — language picker', () => {
  test('switching to German localizes Options immediately and persists across reload', async ({ context, optionsUrl }) => {
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.waitForSelector('#languageSelect')

    // Chrome-English baseline before any manual selection.
    await expect(options.locator('#tab-settings span')).toHaveText('Settings')

    await options.selectOption('#languageSelect', 'de')
    await expect(options.locator('#tab-settings span')).toHaveText('Einstellungen')
    await expect(options.locator('#tab-about span')).toHaveText('Über')
    await expect(options.locator('html')).toHaveAttribute('lang', 'de')

    await options.reload()
    await options.waitForSelector('#languageSelect')
    await expect(options.locator('#tab-settings span')).toHaveText('Einstellungen')
    await expect(options.locator('#languageSelect')).toHaveValue('de')

    await options.close()
  })

  test('language select lists System plus all 55 supported locales', async ({ context, optionsUrl }) => {
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.waitForSelector('#languageSelect')

    const optionCount = await options.locator('#languageSelect option').count()
    expect(optionCount).toBe(1 + 55) // System + 55 locale codes

    await options.close()
  })
})

test.describe('Popup — manual locale reflected on open', () => {
  test('popup opens already localized when a manual German preference is stored', async ({ popupPage }) => {
    await seedLocalePreference(popupPage, 'de')
    await popupPage.reload()
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })

    await expect(popupPage.locator('#btnNewSession span')).toHaveText('Erstellen')
    await expect(popupPage.locator('#searchInput')).toHaveAttribute('placeholder', 'Profile durchsuchen…')
    await expect(popupPage.locator('html')).toHaveAttribute('lang', 'de')
    expect(await popupPage.locator('.v2-popup').getAttribute('inert')).toBeNull()
  })

  test('existing mixed-script profile name and English default fallback are preserved under a manual locale', async ({ popupPage }) => {
    await popupPage.evaluate(async () => {
      await chrome.storage.local.set({
        profiles: [{ id: 'session_mixed', name: 'Work حساب', hue: 200 }],
      })
    })
    await seedLocalePreference(popupPage, 'ar')
    await popupPage.reload()
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })

    // Stored profile name is user data — never translated/rewritten.
    await expect(popupPage.locator('.v2-card-name', { hasText: 'Work حساب' })).toBeVisible()
    // UI chrome around it is localized.
    await expect(popupPage.locator('html')).toHaveAttribute('dir', 'rtl')
  })

  test('reveals accessibly with no permanent inert/hidden state under System (English)', async ({ popupPage }) => {
    expect(await popupPage.locator('.v2-popup').getAttribute('inert')).toBeNull()
    expect(await popupPage.locator('.v2-popup').getAttribute('aria-busy')).toBeNull()
  })

  test('unsupported (non-http) active tab shows localized feedback, no crash, no permanent inert state', async ({ context, popupUrl }) => {
    // Opened as a plain tab (no chrome.tabs.query mock): the "active tab" IS
    // this extension page itself, a chrome-extension:// URL — exercising
    // popup.ts's real early-return branch for pages that can't be isolated.
    const page = await context.newPage()
    await page.goto(popupUrl)
    await seedLocalePreference(page, 'de')
    await page.reload()

    await expect(page.locator('.v2-popup')).toContainText('Diese Seite kann nicht isoliert werden.')
    expect(await page.locator('.v2-popup').getAttribute('inert')).toBeNull()
    expect(await page.locator('.v2-popup').getAttribute('aria-busy')).toBeNull()
    await page.close()
  })
})

test.describe('Phase 4 — RTL/bidirectional hardening', () => {
  test('popup full flow under ar: RTL chrome, mixed-script name isolated, no horizontal overflow', async ({ popupPage }) => {
    await popupPage.evaluate(async () => {
      await chrome.storage.local.set({
        profiles: [{ id: 'session_mixed', name: 'Work حساب 123', hue: 24 }],
      })
    })
    await seedLocalePreference(popupPage, 'ar')
    await popupPage.reload()
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })

    await expect(popupPage.locator('html')).toHaveAttribute('dir', 'rtl')
    const nameEl = popupPage.locator('.v2-card-name', { hasText: 'Work حساب 123' })
    await expect(nameEl).toBeVisible()
    await expect(nameEl).toHaveAttribute('dir', 'auto')

    // No horizontal overflow: content never exceeds the popup's own width.
    const overflow = await popupPage.evaluate(() => {
      const el = document.documentElement
      return el.scrollWidth - el.clientWidth
    })
    expect(overflow).toBeLessThanOrEqual(1) // sub-pixel rounding tolerance

    // CRUD still works with the reversed reading direction.
    await popupPage.fill('#newSessionName', 'Second')
    await Promise.all([
      popupPage.waitForLoadState('load'),
      popupPage.click('#btnNewSession'),
    ])
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })
    await expect(popupPage.locator('.v2-card-name', { hasText: 'Second' })).toBeVisible()
  })

  test('options toggle/CTA under ar: correct inline placement, tab order unchanged', async ({ context, optionsUrl }) => {
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await seedLocalePreference(options, 'ar')
    await options.reload()
    await options.waitForSelector('#languageSelect')

    await expect(options.locator('html')).toHaveAttribute('dir', 'rtl')

    // Toggle thumb travels via inset-inline-start (not a physical transform),
    // so its computed `left` must actually change between states even under
    // rtl — a physical translateX would have looked identical either way.
    const toggle = options.locator('#autoInheritToggle')
    const thumbLeft = () => toggle.evaluate((el) => parseFloat(getComputedStyle(el, '::before').insetInlineStart))

    if (!(await toggle.isChecked())) await toggle.click()
    await expect(toggle).toBeChecked()
    await options.waitForTimeout(200) // let the 0.15s inset-inline-start transition settle
    const leftWhenChecked = await thumbLeft()

    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await options.waitForTimeout(200)
    const leftWhenUnchecked = await thumbLeft()

    expect(Number.isFinite(leftWhenChecked)).toBe(true)
    expect(Number.isFinite(leftWhenUnchecked)).toBe(true)
    expect(leftWhenChecked).not.toBe(leftWhenUnchecked)

    // DOM/tab order must not reverse under rtl: Tab from the last theme button
    // walks the settings rows in source order, top to bottom.
    await options.locator('.opt-theme-btn[data-theme-val="light"]').focus()
    const tabTo = async () => {
      await options.keyboard.press('Tab')
      return options.evaluate(() => document.activeElement?.id)
    }
    expect(await tabTo()).toBe('autoInheritToggle')
    expect(await tabTo()).toBe('groupTabsByProfileToggle')
    expect(await tabTo()).toBe('languageSelect')

    await options.close()
  })

  test('color picker popover anchors from the dot\'s left edge under en and clamps in-viewport', async ({ popupPage }) => {
    await popupPage.evaluate(async () => {
      await chrome.storage.local.set({
        profiles: [{ id: 'session_a', name: 'A', hue: 10 }],
      })
    })
    await popupPage.reload()
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })

    const colorDot = popupPage.locator('.v2-card-color').first()
    const dotBox = await colorDot.boundingBox()
    await colorDot.click()
    const popover = popupPage.locator('.v2-color-popover')
    await expect(popover).toBeVisible()
    const box = await popover.boundingBox()
    const viewport = popupPage.viewportSize()
    expect(box).not.toBeNull()
    expect(dotBox).not.toBeNull()
    if (box && viewport) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
    }
    if (box && dotBox) {
      // ltr anchors from the dot's own left edge (no width subtraction needed).
      expect(Math.abs(box.x - dotBox.x)).toBeLessThan(2)
    }
  })

  test('color picker popover anchors from the dot\'s right edge under ar and clamps in-viewport', async ({ popupPage }) => {
    await popupPage.evaluate(async () => {
      await chrome.storage.local.set({
        profiles: [{ id: 'session_a', name: 'A', hue: 10 }],
      })
    })
    await seedLocalePreference(popupPage, 'ar')
    await popupPage.reload()
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })
    await expect(popupPage.locator('html')).toHaveAttribute('dir', 'rtl')

    const colorDot = popupPage.locator('.v2-card-color').first()
    const dotBox = await colorDot.boundingBox()
    await colorDot.click()
    const popover = popupPage.locator('.v2-color-popover')
    await expect(popover).toBeVisible()
    const box = await popover.boundingBox()
    const viewport = popupPage.viewportSize()
    expect(box).not.toBeNull()
    expect(dotBox).not.toBeNull()
    if (box && viewport) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
    }
    if (box && dotBox) {
      // rtl anchors so the popover's right edge sits near the dot's right
      // edge (mirroring ltr), not merely "somewhere onscreen" by luck of
      // the viewport clamp.
      expect(Math.abs(box.x + box.width - (dotBox.x + dotBox.width))).toBeLessThan(2)
    }
  })

})

test.describe('Phase 5 — regional fallback and representative-script matrix', () => {
  test('en_GB, es_419, pt_BR, zh_TW each render their own exact catalog, not a generic pt/zh/es fallback', async ({ context, optionsUrl }) => {
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.waitForSelector('#languageSelect')

    const cases: Array<{ code: string; createButton: string; tabSettings: string }> = [
      { code: 'en_GB', createButton: 'Create', tabSettings: 'Settings' },
      { code: 'es_419', createButton: 'Crear', tabSettings: 'Configuración' },
      { code: 'pt_BR', createButton: 'Criar', tabSettings: 'Configurações' },
      { code: 'zh_TW', createButton: '建立', tabSettings: '設定' },
    ]

    for (const { code, tabSettings } of cases) {
      await options.selectOption('#languageSelect', code)
      await expect(options.locator('#tab-settings span')).toHaveText(tabSettings)
      await expect(options.locator('html')).toHaveAttribute('lang', code.replace('_', '-'))
    }

    await options.close()
  })

  test('Vietnamese and Japanese popups render their own script with correct lang tag', async ({ popupPage }) => {
    await seedLocalePreference(popupPage, 'vi')
    await popupPage.reload()
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })
    await expect(popupPage.locator('#btnNewSession span')).toHaveText('Tạo')
    await expect(popupPage.locator('html')).toHaveAttribute('lang', 'vi')
    await expect(popupPage.locator('html')).toHaveAttribute('dir', 'ltr')

    await seedLocalePreference(popupPage, 'ja')
    await popupPage.reload()
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })
    await expect(popupPage.locator('#btnNewSession span')).toHaveText('作成')
    await expect(popupPage.locator('html')).toHaveAttribute('lang', 'ja')
  })

  test('Hindi (Devanagari, complex shaping) popup renders readable script with no crash', async ({ popupPage }) => {
    await seedLocalePreference(popupPage, 'hi')
    await popupPage.reload()
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })
    await expect(popupPage.locator('#btnNewSession span')).toHaveText('बनाएं')
    await expect(popupPage.locator('html')).toHaveAttribute('lang', 'hi')
    expect(await popupPage.locator('.v2-popup').getAttribute('inert')).toBeNull()
  })
})

test.describe('Phase 5 — critical-key beta fallback (translation-quality.json)', () => {
  test('under de (beta tier), the delete-confirmation flow renders in English while decorative/cancel chrome stays German', async ({ popupPage }) => {
    await popupPage.evaluate(async () => {
      await chrome.storage.local.set({
        profiles: [{ id: 'session_a', name: 'Work', hue: 200 }],
      })
    })
    await seedLocalePreference(popupPage, 'de')
    await popupPage.reload()
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })

    // Decorative copy (not a critical key) uses the German draft immediately.
    await expect(popupPage.locator('.v2-brand-sub')).toHaveText('Multi-Konto-Manager')

    const card = popupPage.locator('.v2-card', { hasText: 'Work' })
    await card.locator('[data-action="delete-profile"]').click()

    // deleteTitle is a critical key: stays English until de is reviewed or
    // this exact key is marked criticalKeyEligible.
    await expect(card.locator('[data-action="confirm-delete"]')).toHaveText('Delete')
    // cancelButton/cancelDeleteTitle are not critical: German draft renders.
    await expect(card.locator('[data-action="cancel-delete"]')).toHaveText('Abbrechen')
    await expect(card.locator('[data-action="cancel-delete"]')).toHaveAttribute('title', 'Löschen abbrechen')
  })
})

test.describe('Phase 4 — RTL/bidirectional hardening (menu positioning)', () => {
  test('keyboard-invoked open-in-tab menu anchors near the card under ar (not just clamped onscreen)', async ({ popupPage }) => {
    await popupPage.evaluate(async () => {
      await chrome.storage.local.set({
        profiles: [{ id: 'session_kb', name: 'KeyboardTarget', hue: 40 }],
      })
    })
    await seedLocalePreference(popupPage, 'ar')
    await popupPage.reload()
    await popupPage.waitForSelector('#btnNewSession', { state: 'visible' })
    await expect(popupPage.locator('html')).toHaveAttribute('dir', 'rtl')

    const card = popupPage.locator('.v2-card', { hasText: 'KeyboardTarget' })
    const cardBox = await card.boundingBox()
    await card.focus()
    await popupPage.keyboard.press('Shift+F10')
    const menuItem = popupPage.locator('[data-action="open-in-new-tab"]')
    await expect(menuItem).toBeVisible()
    const menuBox = await menuItem.evaluate((el) => {
      const menu = el.closest('.v2-open-tab-menu') as HTMLElement
      const rect = menu.getBoundingClientRect()
      return { x: rect.x, width: rect.width }
    })
    expect(cardBox).not.toBeNull()
    if (cardBox) {
      // Anchored near the card's own right edge (fallbackX = cardRect.right -
      // 16 - menuWidth), not dumped at the clamped far edge of the viewport.
      const expectedRight = cardBox.x + cardBox.width - 16
      expect(Math.abs(menuBox.x + menuBox.width - expectedRight)).toBeLessThan(4)
    }
  })
})
