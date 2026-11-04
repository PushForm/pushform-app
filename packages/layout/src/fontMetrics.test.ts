// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterAll, expect, it, vi } from 'vitest';
import type { LayoutText } from './LayoutDocument';
import { layoutFontVerticalEm, layoutTextLineHeightMm } from './text';

// No page here, as in an import worker: fonts are measured on an offscreen canvas.
vi.stubGlobal('OffscreenCanvas', class {
  getContext() {
    return {
      font: '',
      measureText(this: { font: string }) {
        const size = parseFloat(this.font.replace(/^(italic |bold )*/, ''));
        const wide = this.font.includes('"Wide"');
        return { width: 1, fontBoundingBoxAscent: size * (wide ? 1 : 0.9), fontBoundingBoxDescent: size * (wide ? 0.25 : 0.2) };
      },
    };
  }
});
afterAll(() => { vi.unstubAllGlobals(); });

const text = (overrides: Partial<LayoutText>): LayoutText => ({
  content: 'First\nLast', fontFamily: 'Wide', fontSizePt: 10, color: '#000000', bold: false, italic: false, underline: false,
  align: 'left', vertical: 'top', bounded: false, leader: 'straight', endpoint: 'none', ...overrides,
});
const pt = 25.4 / 72;

it('measures a font\'s ascent and descent on an offscreen canvas where there is no page', () => {
  expect(layoutFontVerticalEm({ fontFamily: 'Wide', bold: false, italic: false })).toEqual({ ascent: 1, descent: 0.25 });
  expect(layoutFontVerticalEm({ fontFamily: 'Narrow', bold: true, italic: false })).toEqual({ ascent: 0.9, descent: 0.2 });
});

it('measures a first or last line as it is painted: its largest font, under the line spacing', () => {
  expect(layoutTextLineHeightMm(text({}), false)).toBeCloseTo(10 * 1.25 * pt, 9);
  // A larger font on the last line only.
  const mixed = text({ spans: [{ start: 6, end: 10, bold: false, italic: false, underline: false, fontSizePt: 20, fontFamily: 'Narrow' }] });
  expect(layoutTextLineHeightMm(mixed, false)).toBeCloseTo(10 * 1.25 * pt, 9);
  expect(layoutTextLineHeightMm(mixed, true)).toBeCloseTo(20 * 1.1 * pt, 9);
  expect(layoutTextLineHeightMm(text({ lineSpacing: { mode: 'multiple', value: 1.5 } }), false)).toBeCloseTo(10 * 1.25 * 1.5 * pt, 9);
  expect(layoutTextLineHeightMm(text({ lineSpacing: { mode: 'exactly', value: 30 } }), true)).toBeCloseTo(30 * pt, 9);
  // An empty first line takes the style at its line break.
  expect(layoutTextLineHeightMm(text({ content: '\nText', spans: [{ start: 0, end: 1, bold: false, italic: false, underline: false, fontSizePt: 16 }] }), false)).toBeCloseTo(16 * 1.25 * pt, 9);
});
