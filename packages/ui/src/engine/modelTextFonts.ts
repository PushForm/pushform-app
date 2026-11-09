// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { GOOGLE_LAYOUT_FONTS } from '../components/layoutFontCatalog';

/**
 * Font files for model text. The 3D text renderer draws from font files, not from the browser's
 * installed fonts, and it reads TTF, OTF and WOFF but not WOFF2, which is all Google Fonts serves to
 * current browsers. So a family from the font list is drawn from the Fontsource mirror of the same
 * Google font, in WOFF; any other family keeps the default typeface.
 */
const FONT_MIRROR = 'https://cdn.jsdelivr.net/fontsource/fonts';

/** Faces the catalog lists that the mirror has no WOFF file for. */
const NO_FILE = new Set(['Noto Color Emoji|0,400', 'Roboto Flex|0,700']);

const faces = new Map<string, readonly string[]>(GOOGLE_LAYOUT_FONTS.map((font) => [
  font.family,
  font.styles.filter((style) => !NO_FILE.has(`${font.family}|${style}`)),
]));

/**
 * The font file for `family` in this weight and style, or undefined when the family is not in the
 * font list (the default typeface is drawn then). When the family has no face of that weight and
 * style, the nearest one it has: the right style first, then the other weight.
 */
export function modelTextFontUrl(family: string, bold: boolean, italic: boolean): string | undefined {
  const styles = faces.get(family);
  if (!styles?.length) return undefined;
  const slant = italic ? '1' : '0', weight = bold ? '700' : '400';
  const score = (style: string) => {
    const [s, w] = style.split(',');
    return (s === slant ? 0 : 2) + (w === weight ? 0 : 1);
  };
  const [s, w] = [...styles].sort((a, b) => score(a) - score(b))[0]!.split(',');
  const id = family.toLowerCase().replace(/\s+/g, '-');
  return `${FONT_MIRROR}/${id}@latest/latin-${w}-${s === '1' ? 'italic' : 'normal'}.woff`;
}
