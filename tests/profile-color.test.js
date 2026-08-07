import { describe, it, expect } from 'vitest'
import {
  DEFAULT_HUE,
  HUE_PALETTE,
  resolveProfileHue,
  normalizeHue,
  hueToRgb,
  relativeLuminance,
  badgeBackgroundRgba,
  badgeTextRgba,
  profileColorCss,
  profileSwatchCss,
  nearestTabGroupColor,
} from '../lib/profile-color.js'

function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

describe('resolveProfileHue', () => {
  it('prefers an explicit hue over everything else', () => {
    expect(resolveProfileHue({ hue: 42, color: '#dc2626' }, 3)).toBe(42)
  })

  it('accepts hue 0 rather than treating it as absent', () => {
    expect(resolveProfileHue({ hue: 0 }, 3)).toBe(0)
  })

  it('migrates every legacy hex color to its hue', () => {
    const legacy = {
      '#7c3aed': 262,
      '#2563eb': 219,
      '#059669': 161,
      '#d97706': 36,
      '#dc2626': 0,
      '#db2777': 333,
      '#0891b2': 191,
    }
    for (const [color, hue] of Object.entries(legacy)) {
      expect(resolveProfileHue({ color }, 5)).toBe(hue)
    }
  })

  it('falls back to the palette by index, wrapping past its length', () => {
    expect(resolveProfileHue({}, 0)).toBe(HUE_PALETTE[0])
    expect(resolveProfileHue({}, HUE_PALETTE.length)).toBe(HUE_PALETTE[0])
    expect(resolveProfileHue({}, HUE_PALETTE.length + 2)).toBe(HUE_PALETTE[2])
  })

  it('ignores an unrecognised legacy color and uses the palette', () => {
    expect(resolveProfileHue({ color: '#123456' }, 1)).toBe(HUE_PALETTE[1])
  })
})

describe('normalizeHue', () => {
  it('wraps out-of-range and negative hues into 0-359', () => {
    expect(normalizeHue(0)).toBe(0)
    expect(normalizeHue(360)).toBe(0)
    expect(normalizeHue(400)).toBe(40)
    expect(normalizeHue(-30)).toBe(330)
  })

  it('falls back to the default hue for non-finite input', () => {
    expect(normalizeHue(NaN)).toBe(DEFAULT_HUE)
  })
})

describe('hueToRgb', () => {
  it('produces the canonical primaries at full saturation and mid lightness', () => {
    expect(hueToRgb(0, 1, 0.5)).toEqual([255, 0, 0])
    expect(hueToRgb(120, 1, 0.5)).toEqual([0, 255, 0])
    expect(hueToRgb(240, 1, 0.5)).toEqual([0, 0, 255])
  })

  it('collapses to greyscale when saturation is zero', () => {
    expect(hueToRgb(200, 0, 0.5)).toEqual([128, 128, 128])
    expect(hueToRgb(200, 0, 0)).toEqual([0, 0, 0])
    expect(hueToRgb(200, 0, 1)).toEqual([255, 255, 255])
  })

  it('clamps saturation and lightness outside 0-1', () => {
    expect(hueToRgb(0, 5, 0.5)).toEqual([255, 0, 0])
    expect(hueToRgb(0, 1, -1)).toEqual([0, 0, 0])
  })
})

describe('badge contrast', () => {
  it('clears 4.5:1 for every integer hue', () => {
    const failures = []
    for (let hue = 0; hue < 360; hue++) {
      const bg = badgeBackgroundRgba(hue).slice(0, 3)
      const fg = badgeTextRgba(hue).slice(0, 3)
      const ratio = contrastRatio(bg, fg)
      if (ratio < 4.5) failures.push({ hue, ratio: Number(ratio.toFixed(2)) })
    }
    expect(failures).toEqual([])
  })

  it('picks the higher-contrast label of black and white', () => {
    for (const hue of HUE_PALETTE) {
      const bg = badgeBackgroundRgba(hue).slice(0, 3)
      const chosen = badgeTextRgba(hue).slice(0, 3)
      const other = chosen[0] === 0 ? [255, 255, 255] : [0, 0, 0]
      expect(contrastRatio(bg, chosen)).toBeGreaterThanOrEqual(contrastRatio(bg, other))
    }
  })

  it('returns fully opaque rgba quadruples', () => {
    expect(badgeBackgroundRgba(212)).toHaveLength(4)
    expect(badgeBackgroundRgba(212)[3]).toBe(255)
    expect(badgeTextRgba(212)[3]).toBe(255)
  })

  it('uses a white label on dark blue and a black label on yellow', () => {
    expect(badgeTextRgba(240)).toEqual([255, 255, 255, 255])
    expect(badgeTextRgba(55)).toEqual([0, 0, 0, 255])
  })
})

describe('css helpers', () => {
  it('profileColorCss matches badgeBackgroundRgba for the same hue', () => {
    for (const hue of HUE_PALETTE) {
      const [, , s, l] = profileColorCss(hue).match(/hsl\((\d+), (\d+)%, (\d+)%\)/).map(Number)
      expect(hueToRgb(hue, s / 100, l / 100)).toEqual(badgeBackgroundRgba(hue).slice(0, 3))
    }
  })

  it('normalizes the hue it embeds', () => {
    expect(profileColorCss(400)).toBe(profileColorCss(40))
    expect(profileSwatchCss(-30)).toBe(profileSwatchCss(330))
  })

  it('keeps the popup swatch tone distinct from the badge tone', () => {
    expect(profileSwatchCss(212)).toBe('hsl(212, 70%, 55%)')
    expect(profileColorCss(212)).toBe('hsl(212, 85%, 42%)')
  })
})

describe('nearestTabGroupColor', () => {
  it('matches every anchor hue exactly', () => {
    const anchors = { red: 0, orange: 30, yellow: 55, green: 130, cyan: 190, blue: 217, purple: 270, pink: 330 }
    for (const [color, hue] of Object.entries(anchors)) {
      expect(nearestTabGroupColor(hue)).toBe(color)
    }
  })

  it('never returns grey — it is excluded from the candidate search', () => {
    for (let hue = 0; hue < 360; hue += 5) {
      expect(nearestTabGroupColor(hue)).not.toBe('grey')
    }
  })

  it('handles wrap-around correctly around the red anchor (hue 0/360)', () => {
    expect(nearestTabGroupColor(350)).toBe('red') // 10° from red, 20° from pink
    expect(nearestTabGroupColor(355)).toBe('red') // 5° from red
    expect(nearestTabGroupColor(340)).toBe('pink') // 10° from pink, 20° from red
    expect(nearestTabGroupColor(5)).toBe('red') // 5° from red
  })

  it('normalizes non-finite and out-of-range input via normalizeHue', () => {
    expect(nearestTabGroupColor(400)).toBe(nearestTabGroupColor(40))
    expect(nearestTabGroupColor(NaN)).toBe(nearestTabGroupColor(DEFAULT_HUE))
  })
})
