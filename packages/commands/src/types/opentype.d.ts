// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// The parts of opentype.js 2.0 that 3D Text uses (the package ships no type declarations).
declare module 'opentype.js/dist/opentype.mjs' {
  export interface PathCommand {
    type: 'M' | 'L' | 'Q' | 'C' | 'Z';
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  export interface Path {
    commands: PathCommand[];
  }
  export interface Glyph {
    index: number;
    advanceWidth?: number;
    /** The outline at `fontSize`, with y pointing down (screen convention) from the baseline at `y`. */
    getPath(x: number, y: number, fontSize: number): Path;
  }
  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    tables: { os2?: { sCapHeight?: number }; hhea?: { lineGap?: number } };
    charToGlyph(c: string): Glyph;
    getKerningValue(left: Glyph, right: Glyph): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
