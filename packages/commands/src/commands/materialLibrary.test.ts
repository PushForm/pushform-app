// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { imageSizeFromHeader } from '@pushform/model';
import { BUILTIN_LIBRARY, LIBRARY_CATEGORIES, loadLibraryTexture } from './materialLibrary';
import sources from './material-textures/sources.json';

describe('bundled material library', () => {
  it('contains the requested totals with unique material and source identities', () => {
    const expected = {
      Colors: 24, Wood: 50, Brick: 30, Ceramic: 26, 'Concrete & Asphalt': 50,
      Stone: 50, Metal: 26, Terrain: 50, Textiles: 44, Plastic: 6, Organic: 6, Glass: 6,
    };
    expect(new Set(LIBRARY_CATEGORIES)).toEqual(new Set(Object.keys(expected)));
    for (const category of LIBRARY_CATEGORIES) {
      const entries = BUILTIN_LIBRARY.filter((m) => m.category === category);
      expect(entries.length, category).toBe(expected[category]);
      if (!['Colors', 'Glass'].includes(category)) expect(entries.every((m) => m.texture), category).toBe(true);
    }
    expect(new Set(BUILTIN_LIBRARY.map((m) => m.key)).size).toBe(BUILTIN_LIBRARY.length);
    expect(new Set(BUILTIN_LIBRARY.map((m) => m.name)).size).toBe(BUILTIN_LIBRARY.length);
    expect(new Set(sources.textures.map((m) => m.asset)).size).toBe(338);
    expect(sources.textures.filter((m) => m.sourceCategory.startsWith('Concrete/'))).toHaveLength(38);
    expect(sources.textures.filter((m) => m.sourceCategory.startsWith('Asphalt & Bitumen/'))).toHaveLength(12);
  });

  it('ships valid full resolution maps and compact previews with documented provenance', async () => {
    const hashes = new Set<string>();
    for (const material of BUILTIN_LIBRARY) {
      if (!material.texture) continue;
      const { texture } = material;
      const bytes = (await loadLibraryTexture(material.key))!;
      expect(imageSizeFromHeader(bytes)).toEqual({ width: texture.widthPx, height: texture.heightPx });
      expect(Math.max(texture.widthPx, texture.heightPx)).toBeGreaterThanOrEqual(1024);
      expect(texture.widthM).toBeGreaterThan(0);
      expect(texture.heightM).toBeGreaterThan(0);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const source = sources.textures.find((s) => s.key === material.key)!;
      expect(source.sha256).toBe(hash);
      expect(source.widthPx).toBe(texture.widthPx);
      expect(source.heightPx).toBe(texture.heightPx);
      hashes.add(hash);
      const preview = await readFile(new URL(texture.previewUrl));
      const previewSize = imageSizeFromHeader(preview)!;
      expect(previewSize).toEqual({ width: source.previewWidthPx, height: source.previewHeightPx });
      expect(Math.max(previewSize.width, previewSize.height)).toBe(128);
      expect(Math.abs(previewSize.width / previewSize.height - texture.widthPx / texture.heightPx)).toBeLessThan(0.02);
      expect(preview.byteLength).toBeLessThan(20_000);
    }
    expect(hashes.size).toBe(338);
  });
});
