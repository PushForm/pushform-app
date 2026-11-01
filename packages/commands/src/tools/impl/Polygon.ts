// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import { tessellatePolygon } from '@pushform/geom';
import type { Tessellation } from '@pushform/geom';
import type { VcbValue } from '../../vcb/parse';
import type { ToolKeyEvent, ToolStatus } from '../Tool';
import { CircleTool } from './Circle';

/**
 * Polygon tool: a Circle with 6 sides by default (min 3), inscribed in the picked radius.
 * Ctrl (Option on mac) toggles circumscribed (edges tangent to the picked radius); `24c` in the
 * VCB sets a circumscribed radius explicitly. Extruded polygons keep hard edges (see
 * `commands/pushpull.ts`).
 */
export class PolygonTool extends CircleTool {
  override readonly id = 'polygon';
  override readonly title = 'Polygon';
  override segments = 6;
  /** Edges tangent to the picked radius instead of vertices on it. */
  circumscribed = false;

  protected override get shapeName(): string {
    return 'polygon';
  }

  protected override tessellate(center: Vec3, normal: Vec3, radius: number, segments: number, startAngle: number): Tessellation {
    return tessellatePolygon(center, normal, this.vertexRadius(radius, segments), segments, startAngle);
  }

  protected override radiusFromVcb(v: VcbValue): number | null {
    if (v.kind === 'circumscribed') {
      this.circumscribed = true;
      return v.meters;
    }
    if (v.kind === 'radius') {
      this.circumscribed = false;
      return v.meters;
    }
    return v.kind === 'length' ? v.meters / 2 : null;
  }

  protected override onExtraKey(e: ToolKeyEvent): boolean {
    if ((e.key === 'Control' || e.key === 'Alt') && !e.repeat) {
      this.circumscribed = !this.circumscribed;
      this.ctx?.requestRender();
      this.ctx?.statusChanged();
      return true;
    }
    return false;
  }

  override status(): ToolStatus {
    const s = super.status();
    return this.center && this.circumscribed ? { ...s, vcbLabel: 'Diameter (circumscribed)' } : s;
  }

  /** Radius of the vertex circle for a picked radius. */
  private vertexRadius(radius: number, segments: number): number {
    return this.circumscribed ? radius / Math.cos(Math.PI / Math.max(3, segments)) : radius;
  }
}
