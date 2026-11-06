// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { modelTextFontUrl } from './modelTextFonts';

const file = (id: string, face: string) => `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${face}.woff`;

it('draws a family from the font list from its WOFF file in the asked weight and style', () => {
  expect(modelTextFontUrl('Roboto', false, false)).toBe(file('roboto', '400-normal'));
  expect(modelTextFontUrl('Roboto', true, true)).toBe(file('roboto', '700-italic'));
  expect(modelTextFontUrl('Open Sans', true, false)).toBe(file('open-sans', '700-normal'));
});

it('falls back to the nearest face the family has', () => {
  // only a regular face
  expect(modelTextFontUrl('Abril Fatface', true, true)).toBe(file('abril-fatface', '400-normal'));
  // upright and italic regular, no bold: keep the style
  expect(modelTextFontUrl('Changa One', true, true)).toBe(file('changa-one', '400-italic'));
  // the mirror has no bold file for this one
  expect(modelTextFontUrl('Roboto Flex', true, false)).toBe(file('roboto-flex', '400-normal'));
});

it('leaves families that are not in the font list to the default typeface', () => {
  expect(modelTextFontUrl('Arial', false, false)).toBeUndefined();
  expect(modelTextFontUrl('Some Local Font', true, true)).toBeUndefined();
  expect(modelTextFontUrl('Noto Color Emoji', false, false)).toBeUndefined();
});
