// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { imageSizeFromHeader } from '@pushform/model';
import { BUILTIN_LIBRARY, loadLibraryTexture } from './materialLibrary';
import sources from './material-textures/sources.json';

describe('bundled material library', () => {
  it('offers at least six distinct choices in every category', () => {
    for (const category of ['Colors', 'Wood', 'Brick', 'Tile', 'Metal', 'Stone', 'Glass']) {
      const entries = BUILTIN_LIBRARY.filter((m) => m.category === category);
      expect(entries.length, category).toBeGreaterThanOrEqual(6);
      if (!['Colors', 'Glass'].includes(category)) expect(entries.filter((m) => m.texture).length, category).toBeGreaterThanOrEqual(6);
    }
    expect(new Set(BUILTIN_LIBRARY.map((m) => m.key)).size).toBe(BUILTIN_LIBRARY.length);
    expect(new Set(BUILTIN_LIBRARY.map((m) => m.name)).size).toBe(BUILTIN_LIBRARY.length);
  });

  it('ships valid full resolution maps and compact previews with documented provenance', async () => {
    const hashes = new Set<string>();
    for (const material of BUILTIN_LIBRARY) {
      if (!material.texture) continue;
      const { texture } = material;
      const bytes = (await loadLibraryTexture(material.key))!;
      expect(imageSizeFromHeader(bytes)).toEqual({ width: texture.px, height: texture.px });
      expect(texture.px).toBeGreaterThanOrEqual(1024);
      expect(texture.widthM).toBeGreaterThan(0);
      expect(texture.heightM).toBeGreaterThan(0);
      const hash = createHash('sha256').update(bytes).digest('hex');
      expect(sources.textures.find((s) => s.key === material.key)?.sha256).toBe(hash);
      hashes.add(hash);
      const preview = await readFile(new URL(texture.previewUrl));
      expect(imageSizeFromHeader(preview)).toEqual({ width: 128, height: 128 });
      expect(preview.byteLength).toBeLessThan(20_000);
    }
    expect(hashes.size).toBe(30);
  });
});
