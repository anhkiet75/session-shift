// profile-icon-renderer.ts — Rasterizes the toolbar action icon in a profile's hue.
//
// The MV3 service worker has no DOM, so this uses OffscreenCanvas rather than
// document.createElement('canvas'). Results are cached per hue in service-worker
// memory; a worker restart just rebuilds them on demand.

import { profileColorCss } from '../lib/profile-color.js';

/** Sizes Chrome picks between by display density. */
const ICON_SIZES = [16, 32] as const;

/** Logo footprint inside the tile, as a fraction of the tile edge. */
const MARK_SCALE = 0.68;

/** Corner rounding, as a fraction of the tile edge. */
const CORNER_SCALE = 0.22;

export type IconSet = Record<(typeof ICON_SIZES)[number], ImageData>;

// Fetched once per service-worker lifetime. The promise itself is cached so
// concurrent tab activations share a single fetch instead of racing.
let baseBitmapPromise: Promise<ImageBitmap> | null = null;

// Keyed by hue, so recoloring a profile is a natural cache miss and the stale
// entry is harmless. Bounded by the number of distinct user-chosen hues.
const iconCache = new Map<number, Promise<IconSet>>();

function loadBaseBitmap(): Promise<ImageBitmap> {
  if (!baseBitmapPromise) {
    baseBitmapPromise = (async () => {
      const res = await fetch(chrome.runtime.getURL('icons/icon-128.png'));
      return createImageBitmap(await res.blob());
    })();
    // A failed fetch must not poison every later call.
    baseBitmapPromise.catch(() => { baseBitmapPromise = null; });
  }
  return baseBitmapPromise;
}

/**
 * The brand mark recolored to a flat white silhouette, keeping its alpha.
 * Drawing the original blue logo over a saturated fill reads as mud — and
 * disappears outright on blue hues.
 */
function drawSilhouette(base: ImageBitmap, size: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(base, 0, 0, size, size);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

function fillTile(ctx: OffscreenCanvasRenderingContext2D, size: number, hue: number): void {
  ctx.fillStyle = profileColorCss(hue);
  const radius = size * CORNER_SCALE;
  // roundRect is Chrome 99+; a square tile is an acceptable degradation.
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, radius);
    ctx.fill();
  } else {
    ctx.fillRect(0, 0, size, size);
  }
}

function renderIcon(base: ImageBitmap, size: number, hue: number): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;
  fillTile(ctx, size, hue);

  const markSize = Math.round(size * MARK_SCALE);
  const offset = Math.round((size - markSize) / 2);
  ctx.drawImage(drawSilhouette(base, markSize), offset, offset);

  return ctx.getImageData(0, 0, size, size);
}

/**
 * ImageData for every size Chrome asks for, in the given hue.
 * Rejects when the platform lacks OffscreenCanvas or the logo cannot be read;
 * callers fall back to the static icons.
 */
export function getIconSetForHue(hue: number): Promise<IconSet> {
  const cached = iconCache.get(hue);
  if (cached) return cached;

  const pending = (async () => {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas unavailable');
    const base = await loadBaseBitmap();
    const set = {} as IconSet;
    for (const size of ICON_SIZES) set[size] = renderIcon(base, size, hue);
    return set;
  })();

  pending.catch(() => { iconCache.delete(hue); });
  iconCache.set(hue, pending);
  return pending;
}

/** Test seam — drops both caches. */
export function resetIconCache(): void {
  baseBitmapPromise = null;
  iconCache.clear();
}
