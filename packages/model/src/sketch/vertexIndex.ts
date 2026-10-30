// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { MERGE_TOL, type Id, type Vec3 } from '@pushform/core';
import { cellKey, neighborCellKeys, packedPointsWithin } from '@pushform/geom';
import type { Sketch } from '../entities/sketch';

/** Borrow native columns for read queries; no result collection or vertex hash is retained. */
export function* sketchVertexCandidates(sketch: Sketch, point: Vec3, radius = MERGE_TOL, cellSize = MERGE_TOL): Generator<Id> {
  const packed = sketch.packedVertexIndex;
  if (packed) {
    for (const row of packedPointsWithin(packed, point, radius)) yield packed.ids[row]! as Id;
  } else {
    for (const key of neighborCellKeys(point, cellSize)) yield* sketch.vertexHash.get(key) ?? [];
  }
}

/** Call inside the authored transaction before editing vertices. Undo restores packed ownership. */
export function materializeSketchVertexHash(sketch: Sketch, tolerance = MERGE_TOL): void {
  if (!sketch.packedVertexIndex) return;
  sketch.vertexHash.clear();
  for (const vertex of sketch.vertices.values()) {
    const key = cellKey(vertex.p, tolerance), bucket = sketch.vertexHash.get(key);
    if (bucket) bucket.push(vertex.id); else sketch.vertexHash.set(key, [vertex.id]);
  }
  delete sketch.packedVertexIndex;
}
