// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { InstancedBufferAttribute } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { segmentsFromPositions } from '../types';
import type { EdgeSegments } from '../types';
import { createEdgeMaterial } from './EdgeMaterial';
import type { EdgeMaterialOptions } from './EdgeMaterial';

/**
 * Fat-line edge batch (one instance per segment) with per-segment `instanceNormalA/B` and
 * `instanceFlags` attributes consumed by `EdgeMaterial` for the profile pass. Width in CSS px.
 * TODO(render): back edges pass (GreaterDepth, dashed), depth cue, extensions, endpoints.
 */
export class EdgeBatch extends LineSegments2 {
  declare geometry: LineSegmentsGeometry;
  declare material: LineMaterial;
  segmentCount = 0;

  constructor(material: LineMaterial) {
    super(new LineSegmentsGeometry(), material);
    this.name = 'EdgeBatch';
    this.frustumCulled = false;
    this.renderOrder = 1;
  }

  setSegments(segments: EdgeSegments | Float32Array): void {
    const s = segments instanceof Float32Array ? segmentsFromPositions(segments) : segments;
    const n = Math.floor(s.positions.length / 6);
    const g = new LineSegmentsGeometry();
    if (n >= 1) {
      g.setPositions(s.positions);
      g.setAttribute('instanceNormalA', new InstancedBufferAttribute(s.normalA, 3));
      g.setAttribute('instanceNormalB', new InstancedBufferAttribute(s.normalB, 3));
      g.setAttribute('instanceFlags', new InstancedBufferAttribute(s.flags, 1));
      // Per-segment colors (Color by Tag): white = "use the material color" for unflagged segments.
      g.setColors(s.colors && s.colors.length === n * 6 ? s.colors : new Float32Array(n * 6).fill(1));
    } else {
      g.setPositions(new Float32Array([0, 0, 0, 0, 0, 0]));
      g.setAttribute('instanceNormalA', new InstancedBufferAttribute(new Float32Array([0, 0, 1]), 3));
      g.setAttribute('instanceNormalB', new InstancedBufferAttribute(new Float32Array([0, 0, 1]), 3));
      g.setAttribute('instanceFlags', new InstancedBufferAttribute(new Uint8Array(1), 1));
      g.setColors(new Float32Array(6).fill(1));
    }
    this.geometry.dispose();
    this.geometry = g;
    this.computeLineDistances();
    this.segmentCount = n;
    this.visible = n >= 1;
  }

  static createMaterial(width = 1, color = 0x1a1a1a, opts: EdgeMaterialOptions = {}): LineMaterial {
    return createEdgeMaterial({ width, color, ...opts });
  }
}
