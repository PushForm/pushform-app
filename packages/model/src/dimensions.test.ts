// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { FaceLocalId, Id, Vec3 } from '@pushform/core';
import { DEFAULT_UNITS, formatLength } from '@pushform/core';
import type { Body } from './entities/body';
import type { Dimension } from './entities/misc';
import { bodyVertexAt, bodyVertexFaces, dimensionDrawing, dimensionText } from './dimensions';

const dim = (over: Partial<Dimension> = {}): Dimension => ({
  id: 1 as Id, kind: 'linear', start: [0, 0, 0], end: [2, 0, 0], offset: [0, 1, 0], normal: [0, 0, 1], text: null, fontSizePt: 10,
  tagId: 0 as never, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {}, ...over,
});

/** A body with only the faces it needs: id → outer loop. */
const bodyWith = (faces: Record<number, Vec3[]>): Body =>
  ({ faces: new Map(Object.entries(faces).map(([id, loop]) => [Number(id) as FaceLocalId, { id: Number(id), loops: [loop] }])) }) as unknown as Body;

describe('dimension text', () => {
  it('formats the value in model units, prefixes radius and diameter, and fills <> in custom text', () => {
    const len = formatLength(2, DEFAULT_UNITS);
    expect(dimensionText(dim(), 2, DEFAULT_UNITS)).toBe(len);
    expect(dimensionText(dim({ kind: 'radial' }), 2, DEFAULT_UNITS)).toBe(`R ${len}`);
    expect(dimensionText(dim({ kind: 'diametric' }), 2, DEFAULT_UNITS)).toBe(`DIA ${len}`);
    expect(dimensionText(dim({ text: 'Wall <> typ.' }), 2, DEFAULT_UNITS)).toBe(`Wall ${len} typ.`);
    expect(dimensionText(dim({ text: 'Fixed' }), 2, DEFAULT_UNITS)).toBe('Fixed');
  });
});

describe('dimension drawing', () => {
  it('draws extension lines, the offset dimension line with arrows at both ends, and centers the text', () => {
    const at = { start: [0, 0, 0] as Vec3, end: [2, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3, value: 2, center: null };
    const d = dimensionDrawing(dim(), at);
    expect(d.lines).toEqual([[[0, 0, 0], [0, 1, 0]], [[2, 0, 0], [2, 1, 0]], [[0, 1, 0], [2, 1, 0]]]);
    expect(d.arrows).toEqual([{ tip: [0, 1, 0], back: [1, 0, 0] }, { tip: [2, 1, 0], back: [-1, 0, 0] }]);
    expect(d.textAt).toEqual([1, 1, 0]);
    // No offset: the dimension line lies on the measured points, without extension lines.
    expect(dimensionDrawing(dim({ offset: [0, 0, 0] }), at).lines).toEqual([[[0, 0, 0], [2, 0, 0]]]);
  });

  it('draws a radius from the center with one arrow on the arc and the text at the end of its leader', () => {
    const d = dimensionDrawing(dim({ kind: 'radial', offset: [1, 0, 0] }), { start: [0, 0, 0], end: [3, 0, 0], normal: [0, 0, 1], value: 3, center: [0, 0, 0] });
    expect(d.lines).toEqual([[[0, 0, 0], [3, 0, 0]], [[3, 0, 0], [4, 0, 0]]]);
    expect(d.arrows).toEqual([{ tip: [3, 0, 0], back: [-1, 0, 0] }]);
    expect(d.textAt).toEqual([4, 0, 0]);
  });
});

describe('body vertex identity', () => {
  // Three faces meeting at the corner (1, 1, 1) of a unit box; faces 1 and 2 also share (1, 1, 0).
  const body = bodyWith({
    1: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
    2: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    3: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  });

  it('names a corner by the faces through it and finds it again', () => {
    expect(bodyVertexFaces(body, [1, 1, 1])).toEqual([1, 2, 3]);
    expect(bodyVertexAt(body, [1, 2, 3] as FaceLocalId[])).toEqual([1, 1, 1]);
  });

  it('gives no point when the faces share several or none, or a face is gone', () => {
    expect(bodyVertexAt(body, [1, 2] as FaceLocalId[])).toBeNull();
    expect(bodyVertexAt(body, [1, 9] as FaceLocalId[])).toBeNull();
    expect(bodyVertexAt(bodyWith({ 1: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], 2: [[5, 5, 5], [6, 5, 5], [6, 6, 5]] }), [1, 2] as FaceLocalId[])).toBeNull();
  });
});
