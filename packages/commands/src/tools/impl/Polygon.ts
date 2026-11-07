// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { tessellatePolygon } from '@pushform/geom';
import type { Tessellation } from '@pushform/geom';
import type { VcbValue } from '../../vcb/parse';
import type { ToolContext, ToolKeyEvent, ToolSetting, ToolSettingValue, ToolStatus } from '../Tool';
import { CircleTool, type CircleParams } from './Circle';

/**
 * Polygon tool: a Circle with 6 sides by default (min 3), inscribed in the picked radius.
 * Ctrl (Cmd on a Mac) toggles circumscribed (edges tangent to the picked radius); `24c` in the
 * VCB sets a circumscribed radius explicitly. The toggle goes back to inscribed each time the
 * tool is chosen. Each polygon records its mode: while the bar shows the polygon just drawn, a
 * Ctrl tap or the bar's toggle redraws it in the other mode (one undo step), and a Sides change
 * keeps its mode. Extruded polygons keep hard edges (see `commands/pushpull.ts`).
 */
export class PolygonTool extends CircleTool {
  override readonly id = 'polygon';
  override readonly title = 'Polygon';
  override segments = 6;
  /** Edges tangent to the picked radius instead of vertices on it (for the next polygon; default off). */
  circumscribed = false;

  override activate(ctx: ToolContext): void {
    super.activate(ctx);
    this.circumscribed = false;
  }

  protected override get shapeName(): string {
    return 'polygon';
  }

  protected override tessellate(p: CircleParams): Tessellation {
    return tessellatePolygon(p.center, p.normal, vertexRadius(p), p.segments, p.startAngle);
  }

  protected override modeParams(): Partial<CircleParams> {
    return { circumscribed: this.circumscribed };
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
    if (e.key === 'Control' && !e.repeat) {
      this.circumscribed = !this.circumscribed;
      // while the bar shows the polygon just drawn, the tap redoes it in the new mode
      if (!this.center && this.lastShown) this.adjustLast('mode');
      this.ctx?.requestRender();
      this.ctx?.statusChanged();
      return true;
    }
    return false;
  }

  protected override barSettings(): ToolSetting[] {
    return [
      ...super.barSettings(),
      {
        kind: 'choice',
        id: 'mode',
        label: 'Polygon',
        value: this.circumscribed ? 'circumscribed' : 'inscribed',
        options: [
          { value: 'inscribed', label: 'Inscribed' },
          { value: 'circumscribed', label: 'Circumscribed' },
        ],
        key: 'primary',
      },
    ];
  }

  protected override adjustable(id: string): boolean {
    return id === 'mode' || super.adjustable(id);
  }

  protected override adjustedParams(id: string, prev: CircleParams): CircleParams {
    return id === 'mode' ? { ...prev, circumscribed: this.circumscribed } : super.adjustedParams(id, prev);
  }

  protected override applySetting(id: string, value: ToolSettingValue): boolean {
    if (id !== 'mode') return super.applySetting(id, value);
    if (value !== 'inscribed' && value !== 'circumscribed') return false;
    this.circumscribed = value === 'circumscribed';
    return true;
  }

  override status(): ToolStatus {
    const s = super.status();
    return this.center && this.circumscribed ? { ...s, vcbLabel: 'Diameter (circumscribed)' } : s;
  }
}

/** Radius of the vertex circle for the picked radius, in the polygon's mode. */
function vertexRadius(p: CircleParams): number {
  return p.circumscribed ? p.radius / Math.cos(Math.PI / Math.max(3, p.segments)) : p.radius;
}
