// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, MeshData, MMat4, Vec3 } from '@pushform/core';
import type { EdgeBlendResult } from '@pushform/kernel';
import type { InferenceOptions } from '@pushform/inference';
import type { Body, EdgeKey } from '@pushform/model';
import { containerAt } from '@pushform/model';
import { kernelOf } from '../../host/services';
import { contextFrame, samePath } from '../../commands/context';
import {
  blendEdgeGroup,
  checkEdgeBlendResult,
  DEFAULT_BLEND_SEGMENTS,
  EdgeBlendParamsSchema,
  planEdgeBlend,
  runEdgeBlendKernel,
  type EdgeBlendKind,
} from '../../commands/edgeBlend';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { pointerField } from '../entry';
import { HOVER_COLOR, hostOfTool } from '../toolUtil';
import { fmtLength } from './constructionUtil';

/** Picked edges (the tool's edge set). */
const PICKED_COLOR = '#f9a825';
/** Debounce between edits of the edge set or value and the kernel preview. */
const PREVIEW_DELAY_MS = 60;
const IDENTITY: MMat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

interface Preview {
  readonly key: string;
  readonly result: EdgeBlendResult;
}

/**
 * Fillet and Chamfer. While active, hovering a solid of the open context
 * highlights the hard edge under the cursor (a curve's edge highlights its whole curve). Click adds
 * it to the edge set, Shift-click toggles it; edges selected when the tool starts are the starting
 * set. The value field takes the radius (Fillet) or distance (Chamfer), remembered for the
 * session, and `Ns` the fillet segments. Enter or double-click commits one `fillet.apply` /
 * `chamfer.apply`; Esc clears the set, a second Esc returns to Select. A kernel preview of the
 * result replaces the solid while edges are picked.
 */
export class EdgeBlendTool implements Tool {
  readonly id: EdgeBlendKind;
  readonly title: string;
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[];

  /** Fillet radius or chamfer distance; null until one is typed (remembered for the session). */
  size: number | null = null;
  /** Fillet segments per full circle (session setting). */
  segments = DEFAULT_BLEND_SEGMENTS;

  private ctx: ToolContext | null = null;
  private bodyId: Id | null = null;
  private picked: EdgeKey[] = [];
  private hover: EdgeKey[] = [];
  private hoverBody: Id | null = null;
  private error: string | null = null;
  private previewError: string | null = null;
  private preview: Preview | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private previewRun: Promise<void> = Promise.resolve();

  constructor(readonly kind: EdgeBlendKind) {
    this.id = kind;
    this.title = kind === 'fillet' ? 'Fillet' : 'Chamfer';
    this.vcbSchema = kind === 'fillet' ? ['length', 'radius', 'segments'] : ['length'];
  }

  // --- test / renderer accessors --------------------------------------------------------------

  /** Edge keys of the current edge set, on solid `edgeSetBodyId`. */
  get edgeSet(): readonly EdgeKey[] {
    return this.picked;
  }
  get edgeSetBodyId(): Id | null {
    return this.bodyId;
  }
  /** Edges highlighted under the cursor. */
  get hoverEdges(): readonly EdgeKey[] {
    return this.hover;
  }
  /** The last refusal or failure shown to the user, if any. */
  get message(): string | null {
    return this.error ?? this.previewError;
  }
  /** Resolves when the queued commit has settled (tests). */
  get settled(): Promise<void> {
    return this.queue;
  }
  /** Resolves when the latest preview has been computed (tests). */
  async previewSettled(): Promise<void> {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
      this.previewRun = this.runPreview();
    }
    await this.previewRun;
  }

  /** Meshes of the previewed result (in the context's coordinates), replacing `previewReplacesBodyId`. */
  get previewMeshes(): readonly MeshData[] {
    const p = this.currentPreview();
    return p ? p.result.components.map((c) => ({ verts: c.mesh.verts, tris: c.mesh.tris, faceId: c.mesh.faceId })) : [];
  }
  get previewReplacesBodyId(): number | null {
    return this.currentPreview() ? this.bodyId : null;
  }
  get previewMatrix(): MMat4 {
    if (!this.ctx) return IDENTITY;
    const host = hostOfTool(this.ctx);
    return contextFrame(host.doc.state, host.context.path).matrix;
  }

  // --- lifecycle ------------------------------------------------------------------------------

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.clearSet();
    // hard edges of a solid selected beforehand become the starting set (whole curves)
    const host = hostOfTool(ctx);
    for (const ref of host.selection.refs) {
      if (ref.kind !== 'edge' || !samePath(ref.path, host.context.path)) continue;
      if (this.bodyId !== null && ref.id !== this.bodyId) continue;
      const body = this.body(ref.id);
      if (!body) continue;
      const group = blendEdgeGroup(body, ref.edgeKey);
      if (!group.length) continue;
      this.bodyId = ref.id;
      for (const k of group) if (!this.picked.includes(k)) this.picked.push(k);
    }
    this.schedulePreview();
  }

  deactivate(): void {
    this.clearSet();
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    // faces are asked for so edges behind them are hidden; only edges are used
    return { pickOnly: true, kinds: ['face', 'edge'] };
  }

  // --- pointer --------------------------------------------------------------------------------

  onPointerMove(e: ToolPointerEvent): void {
    const { body, keys } = this.edgesUnder(e);
    const changed = body !== this.hoverBody || keys.length !== this.hover.length || keys.some((k, i) => k !== this.hover[i]);
    this.hover = keys;
    this.hoverBody = body;
    if (changed) this.ctx?.requestRender();
  }

  onClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.ctx) return;
    const { body, keys } = this.edgesUnder(e);
    if (body === null || !keys.length) return;
    if (body !== this.bodyId) {
      this.bodyId = body;
      this.picked = [];
    }
    if (e.modifiers.shift && keys.every((k) => this.picked.includes(k))) this.picked = this.picked.filter((k) => !keys.includes(k));
    else for (const k of keys) if (!this.picked.includes(k)) this.picked.push(k);
    if (!this.picked.length) this.bodyId = null;
    this.error = null;
    this.edited();
  }

  onDoubleClick(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.commit();
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.key !== 'Enter' || e.repeat) return false;
    this.commit();
    return true;
  }

  onVcb(v: VcbValue): void {
    if (v.kind === 'segments' && this.kind === 'fillet') {
      if (v.count >= 3 && v.count <= 999) this.segments = v.count;
    } else if ((v.kind === 'length' || v.kind === 'radius') && v.meters > 0) {
      this.size = v.meters;
    } else return;
    this.error = null;
    this.edited();
  }

  onCancel(): void {
    if (this.picked.length || this.error || this.previewError) {
      this.clearSet();
      this.ctx?.statusChanged();
      this.ctx?.requestRender();
      return;
    }
    const ctx = this.ctx;
    if (ctx?.commands.has('tool.select')) ctx.commands.execute('tool.select');
  }

  // --- overlay / status -----------------------------------------------------------------------

  overlay(): readonly OverlayPrimitive[] {
    if (!this.ctx) return [];
    const out: OverlayPrimitive[] = [];
    const preview = this.currentPreview() !== null;
    if (this.bodyId !== null && !preview) out.push(...this.edgeLines(this.bodyId, this.picked, PICKED_COLOR));
    if (this.hoverBody !== null) out.push(...this.edgeLines(this.hoverBody, this.hover.filter((k) => this.hoverBody !== this.bodyId || !this.picked.includes(k) || preview), HOVER_COLOR));
    return out;
  }

  status(): ToolStatus {
    const label = this.kind === 'fillet' ? 'Radius' : 'Distance';
    const value = this.size === null ? undefined : fmtLength(this.ctx, this.size);
    const failed = this.error ?? this.previewError;
    let instructor: string;
    if (failed) instructor = `${this.title}: ${failed}`;
    else if (!this.picked.length) instructor = `Click edges of a solid to ${this.kind === 'fillet' ? 'round' : 'bevel'} (Shift-click toggles).`;
    else if (this.size === null) instructor = `Type the ${label.toLowerCase()}.`;
    else instructor = `${this.picked.length} edge${this.picked.length === 1 ? '' : 's'} picked. Press Enter or double-click to apply, Esc to clear.`;
    return { instructor, vcbLabel: label, vcbValue: value, fields: this.picked.length ? [pointerField(label, 'length', value)] : [] };
  }

  // --- internals ------------------------------------------------------------------------------

  private body(id: Id): Body | undefined {
    if (!this.ctx) return undefined;
    const host = hostOfTool(this.ctx);
    try {
      return containerAt(host.doc.state, host.context.path).bodies.get(id);
    } catch {
      return undefined;
    }
  }

  /** The hard edge (or whole curve) under the pointer on a solid of the open context. */
  private edgesUnder(e: ToolPointerEvent): { body: Id | null; keys: EdgeKey[] } {
    const ref = e.inference?.hit?.ref;
    if (!this.ctx || !ref || ref.kind !== 'edge' || !samePath(ref.path, hostOfTool(this.ctx).context.path)) return { body: null, keys: [] };
    const body = this.body(ref.id);
    const keys = body ? blendEdgeGroup(body, ref.edgeKey) : [];
    return keys.length ? { body: ref.id, keys } : { body: null, keys: [] };
  }

  private edgeLines(bodyId: Id, keys: readonly EdgeKey[], color: string): OverlayPrimitive[] {
    const body = this.body(bodyId);
    if (!body || !this.ctx || !keys.length) return [];
    const host = hostOfTool(this.ctx);
    const frame = contextFrame(host.doc.state, host.context.path);
    const out: OverlayPrimitive[] = [];
    for (const k of keys) {
      const e = body.edges.get(k);
      if (e) out.push({ kind: 'polyline', points: e.polyline.map((p: Vec3) => frame.toWorld(p)), color, width: 3 });
    }
    return out;
  }

  private clearSet(): void {
    this.bodyId = null;
    this.picked = [];
    this.hover = [];
    this.hoverBody = null;
    this.error = null;
    this.previewError = null;
    this.preview = null;
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    this.previewTimer = null;
  }

  private edited(): void {
    this.previewError = null;
    this.schedulePreview();
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  private params() {
    if (!this.ctx || this.bodyId === null || !this.picked.length || this.size === null) return null;
    return EdgeBlendParamsSchema.parse({
      path: [...hostOfTool(this.ctx).context.path],
      bodyId: this.bodyId,
      edges: [...this.picked],
      size: this.size,
      segments: this.segments,
    });
  }

  /** Identity of what a preview was computed for (params + body version). */
  private previewKey(): string | null {
    const p = this.params();
    if (!p) return null;
    const body = this.body(p.bodyId as Id);
    return JSON.stringify([p.path, p.bodyId, body?.version, p.edges, p.size, this.kind === 'fillet' ? p.segments : 0]);
  }

  private currentPreview(): Preview | null {
    const p = this.preview;
    return p && p.key === this.previewKey() ? p : null;
  }

  private schedulePreview(): void {
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    if (this.previewKey() === null) return;
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      this.previewRun = this.runPreview();
    }, PREVIEW_DELAY_MS);
  }

  private async runPreview(): Promise<void> {
    const ctx = this.ctx;
    const p = this.params();
    const key = this.previewKey();
    if (!ctx || !p || key === null || this.preview?.key === key) return;
    const host = hostOfTool(ctx);
    try {
      const plan = planEdgeBlend(host.doc.state, this.kind, p);
      const kernel = kernelOf(ctx.commands.ctx);
      const r = await kernel.coalesced(`${this.kind}-preview`, () => runEdgeBlendKernel(kernel, plan, true));
      if (r.status !== 'current' || this.previewKey() !== key) return;
      checkEdgeBlendResult(plan, r.value);
      this.preview = { key, result: r.value };
      this.previewError = null;
    } catch (err) {
      if (this.previewKey() !== key) return;
      this.preview = null;
      this.previewError = err instanceof Error ? err.message : String(err);
    }
    ctx.statusChanged();
    ctx.overlayChanged?.();
    ctx.requestRender();
  }

  private commit(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.picked.length) {
      this.error = 'Click the edges to apply it to first.';
      ctx.statusChanged();
      return;
    }
    const p = this.params();
    if (!p) {
      this.error = `Type the ${this.kind === 'fillet' ? 'radius' : 'distance'} first.`;
      ctx.statusChanged();
      return;
    }
    const pre = this.currentPreview();
    const params = pre ? { ...p, precomputed: pre.result } : p;
    this.queue = this.queue
      .then(async () => {
        await ctx.commands.execute(`${this.kind}.apply`, params);
        this.clearSet();
      })
      .catch((err: unknown) => {
        // nothing changed: explain why and keep the edge set
        this.error = err instanceof Error ? err.message : String(err);
      })
      .then(() => {
        ctx.statusChanged();
        ctx.overlayChanged?.();
        ctx.requestRender();
      });
  }
}

/** Fillet and Chamfer, for the bootstrap's `ToolManager.register` loop. */
export function edgeBlendTools(): EdgeBlendTool[] {
  return [new EdgeBlendTool('fillet'), new EdgeBlendTool('chamfer')];
}
