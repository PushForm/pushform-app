// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { DoubleSide } from 'three';
import type { Mat4 } from '@pushform/core';
import { TextureCache } from '../materials/TextureCache';
import type { RenderImage } from '../types';
import { buildHighlightGeometry } from './HighlightLayer';
import { buildImageArrays, ImageLayer, imageCorners, MISSING_IMAGE_COLOR } from './ImageLayer';

// Placed pictures: two-sided textured quads in world coordinates.
const turned: Mat4 = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1];
const image = (key: string, extra: Partial<RenderImage> = {}): RenderImage => ({
  key, path: [], entityId: 1, transform: turned, widthM: 4, heightM: 2, textureUrl: null, castShadows: true, receiveShadows: false, ...extra,
});

describe('ImageLayer', () => {
  it('lays the picture from its origin corner along the transform, with the whole picture across it', () => {
    expect(imageCorners(image('a'))).toEqual([[10, 0, 0], [10, 4, 0], [8, 4, 0], [8, 0, 0]]);
    const a = buildImageArrays(image('a'), [10, 0, 0]);
    expect([...a.positions.slice(0, 9)]).toEqual([0, 0, 0, 0, 4, 0, -2, 4, 0]);
    expect([...a.uvs]).toEqual([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
    expect([...a.normals.slice(0, 3)].map(v => v + 0)).toEqual([0, 0, 1]);
  });

  it('keeps a mesh per picture while its RenderImage is the same object, and drops removed ones', () => {
    const layer = new ImageLayer(new TextureCache());
    const a = image('a'), b = image('b', { textureUrl: 'blob:b', receiveShadows: true });
    expect(layer.set([a, b], [0, 0, 0])).toBe(true);
    const [ma, mb] = [...layer.renderables];
    expect(ma!.material.side).toBe(DoubleSide);
    expect(ma!.material.color.getHex()).toBe(MISSING_IMAGE_COLOR);
    expect(mb!.material.map).not.toBeNull();
    expect([ma!.castShadow, ma!.receiveShadow, mb!.receiveShadow]).toEqual([true, false, true]);
    expect(layer.set([a, b], [0, 0, 0])).toBe(false);
    expect(layer.set([a], [0, 0, 0])).toBe(true);
    expect([...layer.renderables]).toEqual([ma]);
    const moved = image('a', { transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
    expect(layer.set([moved], [0, 0, 0])).toBe(true);
    expect([...layer.renderables][0]).not.toBe(ma);
    layer.dispose();
  });

  it('fades outside the edit context and in X-ray without writing depth', () => {
    const layer = new ImageLayer(new TextureCache());
    layer.set([image('a')], [0, 0, 0]);
    const [m] = [...layer.renderables];
    m!.setOpacity(true, null);
    expect([m!.material.opacity, m!.material.depthWrite, m!.isFaded]).toEqual([0.35, true, true]);
    m!.setOpacity(false, 0.5);
    expect([m!.material.opacity, m!.material.depthWrite]).toEqual([0.5, false]);
  });

  it('highlights a selected picture with its rectangle filled and outlined', () => {
    const g = buildHighlightGeometry([{ kind: 'image', key: 'a', corners: imageCorners(image('a')) }], [0, 0, 0]);
    expect(g.facePositions.length).toBe(18);
    expect(g.edgePositions.length).toBe(24);
  });
});
