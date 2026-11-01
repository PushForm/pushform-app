// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2, Vec3 } from '@pushform/core';
import { formatArea, formatLength, m4transformPoint, planeFromPointNormal, rayPlane, rayAt, v3dist, v3normalize, v3sub } from '@pushform/core';
import type { InferenceResult } from '@pushform/inference';
import { containerAt, contextMatrix, instanceAt, sketchFaceLoops, type DocumentState, type EntityRef } from '@pushform/model';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';
import { hostOfTool, inferenceOverlay, PREVIEW_COLOR } from '../toolUtil';
import { SCREEN_TEXT_PLACEHOLDER } from '../../commands/texts';

type State = { readonly kind: 'idle' } | { readonly kind: 'label'; readonly anchor: Vec3; readonly text: string; label: Vec3 | null };

const IDLE: State = { kind: 'idle' };
/** Snaps that place leader text at a point, which it then labels with its coordinates. */
const POINT_SNAPS = new Set(['endpoint', 'midpoint', 'intersection', 'center']);

/** Area of a planar polygon with holes (outer loop first), from its points: Newell's vector halves to the area. */
function loopsArea(loops: readonly (readonly Vec3[])[]): number {
  const area = (pts: readonly Vec3[]): number => {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      x += (a[1] - b[1]) * (a[2] + b[2]);
      y += (a[2] - b[2]) * (a[0] + b[0]);
      z += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return Math.hypot(x, y, z) / 2;
  };
  const [outer, ...holes] = loops;
  return outer ? Math.max(0, area(outer) - holes.reduce((sum, h) => sum + area(h), 0)) : 0;
}

/**
 * What new leader text says: the coordinates of a snapped point, the area of a face, the length of an edge,
 * or the name of the group or component clicked; empty otherwise.
 */
export function autoText(state: DocumentState, inf: InferenceResult): string {
  const u = state.meta.units;
  if (POINT_SNAPS.has(inf.primary.kind)) return inf.point.map((c) => formatLength(c, u)).join(', ');
  const hit = inf.hit;
  if (!hit) return '';
  const ref = hit.ref;
  const sel = hit.selectable;
  if (sel && sel.kind === 'instance' && (sel.path.length !== ref.path.length || ref.kind === 'instance')) {
    const inst = instanceAt(state, [...sel.path, sel.id]);
    const def = inst ? state.definitions.get(inst.definitionId) : undefined;
    return inst?.name || def?.name || '';
  }
  const m = contextMatrix(state, ref.path);
  const world = (pts: readonly Vec3[]): Vec3[] => pts.map((p) => m4transformPoint(m, p));
  const container = containerAt(state, ref.path);
  switch (ref.kind) {
    case 'face': {
      const face = container.bodies.get(ref.id)?.faces.get(ref.faceId);
      return face ? formatArea(loopsArea(face.loops.map(world)), u) : '';
    }
    case 'sketchFace': {
      const face = container.sketch.faces.get(ref.id);
      return face ? formatArea(loopsArea(sketchFaceLoops(container.sketch, face).map(world)), u) : '';
    }
    case 'sketchEdge': {
      const e = container.sketch.edges.get(ref.id);
      const a = e && container.sketch.vertices.get(e.a), b = e && container.sketch.vertices.get(e.b);
      return a && b ? formatLength(v3dist(m4transformPoint(m, a.p), m4transformPoint(m, b.p)), u) : '';
    }
    case 'edge': {
      const pts = world(container.bodies.get(ref.id)?.edges.get(ref.edgeKey)?.polyline ?? []);
      let length = 0;
      for (let i = 1; i < pts.length; i++) length += v3dist(pts[i - 1]!, pts[i]!);
      return pts.length > 1 ? formatLength(length, u) : '';
    }
    default:
      return '';
  }
}

/**
 * Text tool: click a face, edge or point to anchor leader text filled in with what it measures, move the
 * label in the plane through the anchor facing the camera, and click to place it; click empty space to place screen
 * text. Placed text opens for editing in place. Escape cancels before the second click.
 */
export class TextTool implements Tool {
  readonly id = 'text';
  readonly title = 'Text';
  readonly cursor = 'crosshair';

  private ctx: ToolContext | null = null;
  private state: State = IDLE;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;

  hasPendingWork(): boolean {
    return this.state.kind !== 'idle';
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.state = IDLE;
  }

  deactivate(): void {
    this.state = IDLE;
    this.ctx = null;
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    if (this.state.kind === 'label') this.state.label = this.labelPoint(e, this.state.anchor);
    this.ctx?.requestRender();
  }

  onClick(e: ToolPointerEvent): void {
    const ctx = this.ctx;
    if (e.button !== 0 || !ctx) return;
    const s = this.state;
    if (s.kind === 'label') {
      const label = this.labelPoint(e, s.anchor) ?? s.anchor;
      this.state = IDLE;
      this.place(ctx, { kind: 'leader', anchor: [...s.anchor], label: [...label], text: s.text });
      return;
    }
    const inf = e.inference;
    if (inf?.hit) {
      this.state = { kind: 'label', anchor: inf.point, text: autoText(hostOfTool(ctx).doc.state, inf), label: null };
      ctx.statusChanged();
      ctx.requestRender();
      return;
    }
    // empty space: screen text where clicked
    const { width, height } = ctx.camera.viewportSize();
    this.place(ctx, { kind: 'screen', screen: [e.screen[0] / Math.max(1, width), e.screen[1] / Math.max(1, height)], text: SCREEN_TEXT_PLACEHOLDER });
  }

  onCancel(): void {
    this.state = IDLE;
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    const s = this.state;
    if (s.kind === 'label') {
      out.push({ kind: 'point', position: s.anchor, color: '#111111', shape: 'square', size: 6 });
      if (s.label) {
        out.push({ kind: 'polyline', points: [s.anchor, s.label], color: PREVIEW_COLOR, width: 1 });
        out.push({ kind: 'label', position: s.label, text: s.text || ' ', color: '#000000' });
      }
    }
    out.push(...inferenceOverlay(this.cursorInference, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    return this.state.kind === 'label'
      ? { instructor: 'Click to place the text. Esc cancels.', vcbLabel: '' }
      : { instructor: 'Click a face, edge or point for leader text, or empty space for screen text.', vcbLabel: '' };
  }

  // --- internals ------------------------------------------------------------------------------

  /** The pointer's point on the plane through the anchor that faces the camera. */
  private labelPoint(e: ToolPointerEvent, anchor: Vec3): Vec3 | null {
    const forward = v3normalize(v3sub(e.camera.target, e.camera.eye));
    const t = rayPlane(e.ray, planeFromPointNormal(anchor, forward));
    return t === null ? null : rayAt(e.ray, t);
  }

  /** Add the text, then open it for editing in place. */
  private place(ctx: ToolContext, params: unknown): void {
    let ref: EntityRef | null = null;
    try {
      ref = ctx.commands.execute('text.add', params) as EntityRef;
    } catch {
      return;
    }
    ctx.commands.tryExecute('ui.editText', { ref });
    ctx.statusChanged();
    ctx.requestRender();
  }
}
