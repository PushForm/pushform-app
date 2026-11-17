// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, MeshData, MMat4, Vec3 } from '@pushform/core';
import { z } from 'zod';
import type { EdgeBlendResult } from '@pushform/kernel';
import type { InferenceOptions } from '@pushform/inference';
import type { Body, EdgeKey } from '@pushform/model';
import { containerAt } from '@pushform/model';
import { kernelOf } from '../../host/services';
import { defineCommand, type AnyCommand } from '../../registry/Command';
import { contextFrame, samePath } from '../../commands/context';
import {
  blendEdgeGroup,
  checkEdgeBlendResult,
  DEFAULT_BLEND_SEGMENTS,
  EdgeBlendParamsSchema,
  EdgeProfileParamsSchema,
  planEdgeBlend,
  planEdgeProfile,
  runEdgeBlendKernel,
  type EdgeBlendMode,
  type EdgeProfile,
} from '../../commands/edgeBlend';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolSetting, ToolSettingValue, ToolStatus } from '../Tool';
import { countFrom, countSetting, degreesFrom, lengthFrom } from '../settings';
import { pointerField } from '../entry';
import { HOVER_COLOR, hostOfTool, redoCommitted } from '../toolUtil';
import { fmtLength } from './constructionUtil';

/** Picked edges (the tool's edge set). */
const PICKED_COLOR = '#f9a825';
/** Debounce between edits of the edge set or value and the kernel preview. */
const PREVIEW_DELAY_MS = 60;
const IDENTITY: MMat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Names of the router-bit profiles of the `profile.apply` command. */
export const PROFILE_LABELS: Readonly<Record<EdgeProfile, string>> = {
  roundover: 'Roundover',
  cove: 'Cove',
  ogee: 'Ogee',
  bead: 'Bead',
  chamfer: 'Chamfer',
  step: 'Step',
};

/** Profile Edges' profiles, in the order its bar offers them. */
export const EDGE_TOOL_PROFILES = ['round', 'chamfer', 'cove', 'ogee', 'bead', 'step'] as const;
export type EdgeToolProfile = (typeof EDGE_TOOL_PROFILES)[number];

export const EDGE_TOOL_PROFILE_LABELS: Readonly<Record<EdgeToolProfile, string>> = {
  round: 'Round',
  chamfer: 'Chamfer',
  cove: 'Cove',
  ogee: 'Ogee',
  bead: 'Bead',
  step: 'Step',
};

/** What each profile's size is called. */
const SIZE_LABELS: Readonly<Record<EdgeToolProfile, string>> = {
  round: 'Radius',
  chamfer: 'Distance',
  cove: 'Radius',
  ogee: 'Width and depth',
  bead: 'Radius',
  step: 'Width and depth',
};

/** Profiles with curves, which take a segment count. */
const CURVED_PROFILES: ReadonlySet<EdgeToolProfile> = new Set(['round', 'cove', 'ogee', 'bead']);

interface Preview {
  readonly key: string;
  readonly result: EdgeBlendResult;
}

/**
 * Profile Edges: rounds, bevels or shapes picked edges of a solid. While active, hovering
 * a solid of the open context highlights the hard edge under the cursor (a curve's edge highlights
 * its whole curve). Click adds it to the edge set, Shift-click toggles it; edges selected when the
 * tool starts are the starting set. Its bar offers the profile, the size, Chamfer's angle and the
 * curved profiles' segments; the value field takes the size, an angle (`30°`, which picks Chamfer)
 * or `Ns`. Round runs `fillet.apply`, Chamfer at 45° `chamfer.apply`, the other profiles and
 * Chamfer at another angle `profile.apply`. Enter or double-click commits; Esc clears the set, a
 * second Esc returns to Select. A kernel preview of the result replaces the solid while edges are
 * picked.
 */
export class EdgeBlendTool implements Tool {
  readonly id = 'profile';
  readonly title = 'Profile Edges';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['length', 'radius', 'angle', 'segments'];

  /** The profile (session setting). */
  profile: EdgeToolProfile = 'round';
  /** Each profile's size; null until one is typed (session settings). */
  private sizes: Partial<Record<EdgeToolProfile, number>> = {};
  /** Segments per full circle of the curved profiles (session setting). */
  segments = DEFAULT_BLEND_SEGMENTS;
  /** Chamfer's angle from the reference face in degrees; 45 until one is typed. */
  angleDeg: number | null = null;

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
  /** The last operation committed and its undo entry, for adjusting it from the bar. */
  private lastApplied: { params: { path: readonly number[]; bodyId: number; edges: readonly string[] }; entry: unknown } | null = null;
  private previewRun: Promise<void> = Promise.resolve();

  /** Switch profile; one without a size of its own yet starts with the current profile's size. */
  private chooseProfile(p: EdgeToolProfile): void {
    if (this.sizes[p] === undefined && this.size !== null) this.sizes[p] = this.size;
    this.profile = p;
  }

  /** The current profile's size, or null until one is typed. */
  get size(): number | null {
    return this.sizes[this.profile] ?? null;
  }
  set size(m: number | null) {
    if (m === null) delete this.sizes[this.profile];
    else this.sizes[this.profile] = m;
  }

  /** The command the current profile runs: Round fillets, Chamfer at 45° chamfers, the rest profile. */
  get kind(): EdgeBlendMode {
    if (this.profile === 'round') return 'fillet';
    if (this.profile === 'chamfer' && (this.angleDeg === null || this.angleDeg === 45)) return 'chamfer';
    return 'profile';
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

  hasPendingWork(): boolean {
    return this.picked.length > 0;
  }

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
    if (v.kind === 'segments') {
      if (v.count < 3 || v.count > 999) return;
      this.segments = v.count;
    } else if (v.kind === 'angle') {
      if (!(v.degrees > 0 && v.degrees < 90)) return;
      this.angleDeg = v.degrees;
      this.chooseProfile('chamfer');
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
    const label = SIZE_LABELS[this.profile];
    const value = this.size === null ? undefined : fmtLength(this.ctx, this.size);
    const failed = this.error ?? this.previewError;
    const name = EDGE_TOOL_PROFILE_LABELS[this.profile].toLowerCase();
    let instructor: string;
    if (failed) instructor = `${this.title}: ${failed}`;
    else if (!this.picked.length) instructor = `Click edges of a solid to shape with ${this.profile === 'round' ? 'a round' : `a ${name}`} (Shift-click toggles).`;
    else if (this.size === null) instructor = `Type the ${label.toLowerCase()}${this.profile === 'chamfer' ? ', or an angle such as 30°' : ''}.`;
    else instructor = `${this.picked.length} edge${this.picked.length === 1 ? '' : 's'} picked. Press Enter or double-click to apply, Esc to clear.`;
    return {
      instructor,
      vcbLabel: label,
      vcbValue: value,
      fields: this.picked.length ? [pointerField(label, 'length', value)] : [],
      settings: this.barSettings(label, value),
      // picking edges keeps the bar usable
      placing: false,
    };
  }

  /** The tool options bar: profile, size, Chamfer's angle, the curved profiles' segments. */
  private barSettings(label: string, value: string | undefined): ToolSetting[] {
    const out: ToolSetting[] = [
      {
        kind: 'choice',
        id: 'profile',
        label: 'Profile',
        value: this.profile,
        display: 'icons',
        options: EDGE_TOOL_PROFILES.map((p) => ({
          value: p,
          label: EDGE_TOOL_PROFILE_LABELS[p],
          icon: `profile-${p === 'round' ? 'roundover' : p}`,
        })),
      },
      { kind: 'quantity', id: 'size', label, value: value ?? '', quantity: 'length' },
    ];
    if (this.profile === 'chamfer') out.push({ kind: 'quantity', id: 'angle', label: 'Angle', value: `${this.angleDeg ?? 45}°`, quantity: 'angle', priority: 2 });
    if (CURVED_PROFILES.has(this.profile)) out.push({ ...countSetting('segments', 'Segments', this.segments), priority: 3 });
    return out;
  }

  /** The bar changed a value just after a commit: redo that operation with it, as one undo step. */
  adjustLast(id: string): boolean {
    const ctx = this.ctx;
    const last = this.lastApplied;
    if (!ctx || !last || !['profile', 'size', 'angle', 'segments'].includes(id) || this.size === null) return false;
    const params = this.paramsFor(last.params.path, last.params.bodyId, last.params.edges);
    const command = `${this.kind}.apply`;
    this.queue = this.queue
      .then(async () => {
        const entry = await redoCommitted(ctx, last.entry, command, params);
        if (entry !== null) this.lastApplied = { params: last.params, entry };
        this.error = null;
      })
      .catch((err: unknown) => {
        // the original stays: explain why
        this.error = err instanceof Error ? err.message : String(err);
      })
      .then(() => {
        ctx.statusChanged();
        ctx.requestRender();
      });
    return true;
  }

  onSetting(id: string, value: ToolSettingValue): void {
    if (id === 'profile' && typeof value === 'string' && (EDGE_TOOL_PROFILES as readonly string[]).includes(value)) {
      this.chooseProfile(value as EdgeToolProfile);
    } else if (id === 'size') {
      const m = lengthFrom(value);
      if (m === null || !(m > 0)) return;
      this.size = m;
    } else if (id === 'angle') {
      const d = degreesFrom(value);
      if (d === null || !(d > 0 && d < 90)) return;
      this.angleDeg = d;
    } else if (id === 'segments') {
      const n = countFrom(value);
      if (n === null || n < 3 || n > 999) return;
      this.segments = n;
    } else return;
    this.error = null;
    this.edited();
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
    return this.paramsFor([...hostOfTool(this.ctx).context.path], this.bodyId, this.picked);
  }

  /** The current profile's command parameters for `edges` of solid `bodyId` in context `path`. */
  private paramsFor(path: readonly number[], bodyId: number, edges: readonly string[]) {
    const size = this.size ?? 0;
    const base = { path: [...path], bodyId, edges: [...edges], size };
    switch (this.kind) {
      case 'fillet':
        return EdgeBlendParamsSchema.parse({ ...base, segments: this.segments });
      case 'chamfer':
        return EdgeBlendParamsSchema.parse(base);
      case 'profile':
        return EdgeProfileParamsSchema.parse({
          ...base,
          profile: this.profile === 'round' ? 'roundover' : this.profile,
          ...(this.profile === 'chamfer' && this.angleDeg !== null ? { angleDeg: this.angleDeg } : {}),
          ...(CURVED_PROFILES.has(this.profile) ? { segments: this.segments } : {}),
        });
    }
  }

  /** Identity of what a preview was computed for (params + body version). */
  private previewKey(): string | null {
    const p = this.params();
    if (!p) return null;
    const body = this.body(p.bodyId as Id);
    return JSON.stringify([p.path, p.bodyId, body?.version, p.edges, p.size, this.kind, this.profile, this.angleDeg, CURVED_PROFILES.has(this.profile) ? this.segments : 0]);
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
      const kind = this.kind;
      const plan = kind === 'profile' ? planEdgeProfile(host.doc.state, EdgeProfileParamsSchema.parse(p)) : planEdgeBlend(host.doc.state, kind, EdgeBlendParamsSchema.parse(p));
      const kernel = kernelOf(ctx.commands.ctx);
      const r = await kernel.coalesced('edge-profile-preview', () => runEdgeBlendKernel(kernel, plan, true));
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
      this.error = `Type the ${SIZE_LABELS[this.profile].toLowerCase()} first.`;
      ctx.statusChanged();
      return;
    }
    const pre = this.currentPreview();
    const params = pre ? { ...p, precomputed: pre.result } : p;
    const command = `${this.kind}.apply`;
    this.queue = this.queue
      .then(async () => {
        await ctx.commands.execute(command, params);
        this.lastApplied = { params: { path: p.path, bodyId: p.bodyId, edges: p.edges }, entry: hostOfTool(ctx).undoStack.peek() ?? null };
        this.clearSet();
        ctx.committed?.();
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

/** Profile Edges, for the bootstrap's `ToolManager.register` loop. */
export function edgeBlendTools(): EdgeBlendTool[] {
  return [new EdgeBlendTool()];
}

/** Command search names that start Profile Edges with a profile chosen. */
const ALIASES: readonly { id: string; title: string; profile: EdgeToolProfile }[] = [
  { id: 'profileEdges.fillet', title: 'Fillet', profile: 'round' },
  { id: 'profileEdges.roundover', title: 'Roundover', profile: 'round' },
  { id: 'profileEdges.round', title: 'Round Edges', profile: 'round' },
  { id: 'profileEdges.chamfer', title: 'Chamfer', profile: 'chamfer' },
];

export const edgeToolAliasCommands: readonly AnyCommand[] = ALIASES.map((a) =>
  defineCommand({
    id: a.id,
    title: a.title,
    category: 'tool',
    icon: 'tool-profile',
    params: z.object({}),
    undoable: false,
    run: (ctx) => {
      ctx.tools?.activate('profile');
      ctx.tools?.setting?.('profile', a.profile);
    },
  }),
);
