// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { FontSource, Text3DFont } from '@pushform/commands';
import robotoLatin400 from '@fontsource/roboto/files/roboto-latin-400-normal.woff?url';
import robotoLatinExt400 from '@fontsource/roboto/files/roboto-latin-ext-400-normal.woff?url';
import robotoLatin700 from '@fontsource/roboto/files/roboto-latin-700-normal.woff?url';
import robotoLatinExt700 from '@fontsource/roboto/files/roboto-latin-ext-700-normal.woff?url';
import serifLatin400 from '@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff?url';
import serifLatinExt400 from '@fontsource/noto-serif/files/noto-serif-latin-ext-400-normal.woff?url';
import serifLatin700 from '@fontsource/noto-serif/files/noto-serif-latin-700-normal.woff?url';
import serifLatinExt700 from '@fontsource/noto-serif/files/noto-serif-latin-ext-700-normal.woff?url';
import monoLatin400 from '@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff?url';
import monoLatinExt400 from '@fontsource/roboto-mono/files/roboto-mono-latin-ext-400-normal.woff?url';
import monoLatin700 from '@fontsource/roboto-mono/files/roboto-mono-latin-700-normal.woff?url';
import monoLatinExt700 from '@fontsource/roboto-mono/files/roboto-mono-latin-ext-700-normal.woff?url';

/**
 * The fonts 3D Text sets type in: Roboto, Noto Serif and Roboto Mono (SIL OFL 1.1), Regular and Bold,
 * Latin and Latin Extended. They ship with the app as assets and download only when 3D text is first made.
 */
const FILES: Readonly<Record<Text3DFont, readonly [regular: readonly string[], bold: readonly string[]]>> = {
  sans: [[robotoLatin400, robotoLatinExt400], [robotoLatin700, robotoLatinExt700]],
  serif: [[serifLatin400, serifLatinExt400], [serifLatin700, serifLatinExt700]],
  mono: [[monoLatin400, monoLatinExt400], [monoLatin700, monoLatinExt700]],
};

export const bundledFonts: FontSource = {
  load: (font, bold) =>
    Promise.all(
      FILES[font][bold ? 1 : 0].map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Could not load the 3D Text font (${res.status})`);
        return res.arrayBuffer();
      }),
    ),
};
