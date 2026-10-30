// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox, type Id, type Ray, type Vec2, type Vec3 } from '@pushform/core';
import { bodyFromMesh, createDocument, SketchGraph, type Document } from '@pushform/model';
import { InferenceEngineImpl } from './InferenceEngineImpl';
import type { InferenceInput } from './types';

/** 1 px = 1 cm at every depth. */
const PX = 0.01;
const down = (x: number, y: number): Ray => ({ origin: [x, y, 10], dir: [0, 0, -1] });
const input = (ray: Ray): InferenceInput => ({ ray, screen: [0, 0], pixelSizeAt: () => PX, project: (p: Vec3): Vec2 => [p[0], p[1]] });

/** A 2 × 1 × 1 box at the origin and a sketch edge at y = 5. */
function fixture(): { doc: Document; bodyId: Id; sketchEdge: Id; engine: InferenceEngineImpl } {
  const doc = createDocument();
  let sketchEdge = 0 as Id;
  const bodyId = doc.transact('fixture', (d) => {
    const root = d.definitions.get(d.rootDefinitionId)!;
    const id = bodyFromMesh(d, meshBox([0, 0, 0], [2, 1, 1]), { container: root.entities }).id;
    sketchEdge = SketchGraph.for(d).addEdge([0, 5, 0], [2, 5, 0])[0]!;
    return id;
  }).value;
  const engine = new InferenceEngineImpl();
  engine.setState(doc.state);
  return { doc, bodyId, sketchEdge, engine };
}

function soften(doc: Document, bodyId: Id, sketchEdge: Id, flag: 'soft' | 'hidden'): void {
  doc.transact(flag, (d) => {
    const root = d.definitions.get(d.rootDefinitionId)!.entities;
    for (const e of root.bodies.get(bodyId)!.edges.values()) e[flag] = true;
    root.sketch.edges.get(sketchEdge)![flag] = true;
  });
}

function showHiddenGeometry(doc: Document, on: boolean): void {
  doc.transact('hidden geometry', (d) => {
    d.styles.get(d.activeStyleId)!.modeling.hiddenGeometry = on;
  });
}

describe('soft and hidden edges are not picked or snapped to unless Hidden Geometry is on', () => {
  for (const flag of ['soft', 'hidden'] as const) {
    it(`${flag} body and sketch edges`, () => {
      const { doc, bodyId, sketchEdge, engine } = fixture();
      expect(engine.pick(input(down(1, 0.003)))?.ref.kind).toBe('edge');
      expect(engine.pick(input(down(1, 5.003)))?.ref.kind).toBe('sketchEdge');
      expect(engine.resolve(input(down(0.003, 0.003))).primary.kind).toBe('endpoint');

      soften(doc, bodyId, sketchEdge, flag);
      engine.setState(doc.state);
      // the face under the cursor is picked instead of its concealed edge; nothing is left at the sketch edge
      expect(engine.pick(input(down(1, 0.003)))?.ref.kind).toBe('face');
      expect(engine.pick(input(down(1, 5.003)))).toBeNull();
      // a corner reached only by concealed edges offers no endpoint
      expect(engine.resolve(input(down(0.003, 0.003))).primary.kind).not.toBe('endpoint');
      expect(engine.resolve(input(down(0.003, 5.003))).primary.kind).not.toBe('endpoint');

      showHiddenGeometry(doc, true);
      engine.setState(doc.state);
      expect(engine.pick(input(down(1, 0.003)))?.ref.kind).toBe('edge');
      expect(engine.pick(input(down(1, 5.003)))?.ref.kind).toBe('sketchEdge');
      expect(engine.resolve(input(down(0.003, 0.003))).primary.kind).toBe('endpoint');

      showHiddenGeometry(doc, false);
      engine.setState(doc.state);
      expect(engine.pick(input(down(1, 0.003)))?.ref.kind).toBe('face');
    });
  }
});
