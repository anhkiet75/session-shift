// popup-color-picker.ts — Inline color dot + swatch popover + custom hue slider for session cards.

import type { PopupSession } from './popup-types.js';
import { HUE_PALETTE } from './popup-types.js';
import type { Localizer } from '../lib/localization.js';

let activePopover: HTMLElement | null = null;
let activeCol: HTMLElement | null = null;

function closeActivePopover(): void {
  if (!activePopover) return;
  activePopover.remove();
  activePopover = null;
  if (activeCol) {
    activeCol.setAttribute('aria-expanded', 'false');
    activeCol = null;
  }
}

document.addEventListener('click', closeActivePopover);
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeActivePopover();
});
document.addEventListener('scroll', closeActivePopover, true);

export function buildColorDot(
  session: PopupSession,
  card: HTMLElement,
  onColorChange: (hue: number) => void,
  localizer: Localizer
): HTMLElement {
  const col = document.createElement('div');
  col.className = 'v2-card-color';
  col.title = localizer.getMessage('changeColorTitle') || 'Change color';
  col.setAttribute('aria-label', localizer.getMessage('changeColorAriaLabel') || 'Change session color');
  col.setAttribute('aria-expanded', 'false');
  col.setAttribute('role', 'button');
  col.tabIndex = 0;

  const dot = document.createElement('span');
  dot.className = 'v2-card-color-dot';
  col.appendChild(dot);

  function togglePopover(e: Event): void {
    e.stopPropagation();
    if (activeCol === col) {
      closeActivePopover();
      return;
    }
    closeActivePopover();
    const popover = buildPopover(session, card, onColorChange, localizer, () => placePopover(popover, col));
    document.body.appendChild(popover);
    col.setAttribute('aria-expanded', 'true');
    activePopover = popover;
    activeCol = col;
    placePopover(popover, col);
  }

  col.addEventListener('click', togglePopover);
  col.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePopover(e); }
  });

  return col;
}

function placePopover(popover: HTMLElement, col: HTMLElement): void {
  const colRect = col.getBoundingClientRect();
  const popoverHeight = popover.offsetHeight || 80;
  const popoverWidth = popover.offsetWidth || 196;
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const gap = 4;
  const margin = 4;

  const spaceBelow = viewportH - colRect.bottom;
  const spaceAbove = colRect.top;
  const flipAbove = spaceBelow < popoverHeight + gap && spaceAbove > spaceBelow;

  const top = flipAbove
    ? Math.max(margin, colRect.top - popoverHeight - gap)
    : colRect.bottom + gap;

  let left = colRect.left;
  if (left + popoverWidth > viewportW - margin) left = viewportW - popoverWidth - margin;
  if (left < margin) left = margin;

  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}

function buildPopover(
  session: PopupSession,
  card: HTMLElement,
  onColorChange: (hue: number) => void,
  localizer: Localizer,
  onResize?: () => void
): HTMLElement {
  const popover = document.createElement('div');
  popover.className = 'v2-color-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', localizer.getMessage('pickColorAriaLabel') || 'Pick session color');
  popover.addEventListener('click', (e) => e.stopPropagation());

  const label = document.createElement('div');
  label.className = 'v2-color-popover-label';
  label.textContent = localizer.getMessage('sessionColorLabel') || 'Session color';
  popover.appendChild(label);

  const swatchRow = document.createElement('div');
  swatchRow.className = 'v2-color-swatches';

  HUE_PALETTE.forEach((h) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'v2-color-swatch';
    sw.style.background = `hsl(${h},70%,55%)`;
    sw.title = localizer.getMessage('hueSwatchTitle', [String(h)]) || `Hue ${h}`;
    sw.setAttribute('aria-pressed', String(session.hue === h));
    sw.addEventListener('click', async () => {
      await applyColor(h);
      closeActivePopover();
    });
    swatchRow.appendChild(sw);
  });

  let sliderWrap: HTMLElement | null = null;

  const customBtn = document.createElement('button');
  customBtn.type = 'button';
  customBtn.className = 'v2-color-swatch-custom';
  customBtn.title = localizer.getMessage('customHueTitle') || 'Custom hue';
  customBtn.setAttribute('aria-label', localizer.getMessage('customHueAriaLabel') || 'Custom hue');
  customBtn.setAttribute('aria-expanded', 'false');
  customBtn.textContent = '+';
  customBtn.addEventListener('click', () => {
    if (customBtn.getAttribute('aria-expanded') === 'true') {
      sliderWrap?.remove();
      sliderWrap = null;
      customBtn.setAttribute('aria-expanded', 'false');
    } else {
      sliderWrap = buildSlider(session, card, onColorChange, localizer);
      popover.appendChild(sliderWrap);
      customBtn.setAttribute('aria-expanded', 'true');
    }
    onResize?.();
  });
  swatchRow.appendChild(customBtn);
  popover.appendChild(swatchRow);

  async function applyColor(hue: number): Promise<void> {
    card.style.setProperty('--hue', String(hue));
    const res = await chrome.runtime.sendMessage({ action: 'colorSession', payload: { sessionId: session.id, hue } })
      .catch(() => null);
    if (!res?.success) {
      card.style.setProperty('--hue', String(session.hue ?? 212));
      return;
    }
    session.hue = hue;
    onColorChange(hue);
  }

  return popover;
}

function buildSlider(
  session: PopupSession,
  card: HTMLElement,
  onColorChange: (hue: number) => void,
  localizer: Localizer
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'v2-hue-slider-wrap';

  const labelRow = document.createElement('div');
  labelRow.className = 'v2-hue-slider-label';
  const spanLeft = document.createElement('span');
  spanLeft.textContent = localizer.getMessage('customLabel') || 'Custom';
  const spanRight = document.createElement('span');
  spanRight.textContent = `${session.hue ?? 212}°`;
  labelRow.appendChild(spanLeft);
  labelRow.appendChild(spanRight);
  wrap.appendChild(labelRow);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '360';
  slider.value = String(session.hue ?? 212);
  slider.className = 'v2-hue-slider';
  slider.setAttribute('aria-label', localizer.getMessage('customHueValueAriaLabel') || 'Custom hue value');

  const preview = document.createElement('div');
  preview.className = 'v2-hue-preview';
  preview.style.background = `hsl(${session.hue ?? 212},70%,55%)`;

  slider.addEventListener('input', () => {
    const h = parseInt(slider.value, 10);
    spanRight.textContent = `${h}°`;
    preview.style.background = `hsl(${h},70%,55%)`;
    card.style.setProperty('--hue', String(h));
  });

  slider.addEventListener('change', async () => {
    const h = parseInt(slider.value, 10);
    const res = await chrome.runtime.sendMessage({ action: 'colorSession', payload: { sessionId: session.id, hue: h } })
      .catch(() => null);
    if (!res?.success) {
      slider.value = String(session.hue ?? 212);
      card.style.setProperty('--hue', String(session.hue ?? 212));
      return;
    }
    session.hue = h;
    onColorChange(h);
  });

  wrap.appendChild(slider);
  wrap.appendChild(preview);
  return wrap;
}
