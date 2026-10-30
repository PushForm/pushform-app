// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { FaceLocalId, Id } from '@pushform/core';
import type { InferenceOptions } from '@pushform/inference';
import type { EntityRef } from '@pushform/model';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';
import { entityOverlay, HOVER_COLOR, hostOfTool } from '../toolUtil';
import { resolveFaceTargetWorld, type FaceTarget } from '../../commands/offset';
import type { FollowMeParams } from '../../commands/followme';
import { samePath } from '../../commands/context';
import { faceTargetOfHit, PATH_COLOR, rootOf, selectionSketchEdgeIds, stateOf } from './constructionUtil';

type State =
  | { readonly kind: 'pickProfile' }
  | {
      /** Profile chosen; the path is collected by hovering/dragging over connected sketch edges. */
      readonly kind: 'path';
      readonly profile: FaceTarget;
      readonly edgeIds: Id[];
      /** Vertex ids at both ends of the chain (equal when closed). */
      start: Id | null;
      end: Id | null;
    };

/**
 * Follow Me. With sketch edges preselected: activate, click the profile face → sweep. Otherwise
 * click the profile face, then hover (or drag) along connected sketch edges, which highlight red,
 * and click to finish. Alt + click a face uses that face's perimeter as the path (lathe when the
 * perimeter is a circle). Commits are async (`settled` resolves when done).
 */
export class FollowMeTool implements Tool {
  readonly id = 'followme';
  readonly title = 'Follow Me';
  readonly cursor = 'crosshair';

  private ctx: ToolContext | null = null;
  private state: State = { kind: 'pickProfile' };
  private preset: Id[] = [];
  private hoverRef: EntityRef | null = null;
  private lastError: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  /** Sketch edges collected for the path so far (or preselected). */
  get pathEdgeIds(): readonly Id[] {
    return this.state.kind === 'path' ? this.state.edgeIds : this.preset;
  }
  get profile(): FaceTarget | null {
    return this.state.kind === 'path' ? this.state.profile : null;
  }
  /** Resolves when every queued commit has settled (tests). */
  get settled(): Promise<void> {
    return this.queue;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.state = { kind: 'pickProfile' };
    this.lastError = null;
    this.preset = selectionSketchEdgeIds(hostOfTool(ctx));
  }
  deactivate(): void {
    this.state = { kind: 'pickProfile' };
    this.preset = [];
    this.hoverRef = null;
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    return this.state.kind === 'path' ? { pickOnly: true, kinds: ['sketchEdge', 'face', 'sketchFace'] } : { pickOnly: true, kinds: ['face', 'sketchFace'] };
  }

  onPointerMove(e: ToolPointerEvent): void {
    const ref = e.inference?.hit?.ref ?? null;
    this.hoverRef = ref;
    const s = this.state;
    if (s.kind === 'path' && ref && ref.kind === 'sketchEdge' && this.inContext(ref)) this.extend(s, ref.id);
    this.ctx?.requestRender();
  }

  onClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.ctx) return;
    const hit = e.inference?.hit ?? null;
    const s = this.state;
    if (s.kind === 'pickProfile') {
      const profile = faceTargetOfHit(stateOf(this.ctx), hit);
      if (!profile) return;
      this.lastError = null;
      if (this.preset.length) {
        this.run({ profile, pathEdgeIds: this.preset as number[] });
        return;
      }
      this.state = { kind: 'path', profile, edgeIds: [], start: null, end: null };
      this.ctx.statusChanged();
      return;
    }
    if (e.modifiers.alt) {
      // Alt + click a face: its perimeter is the path
      const target = faceTargetOfHit(stateOf(this.ctx), hit);
      if (target) {
        const info = resolveFaceTargetWorld(stateOf(this.ctx), target);
        const outer = info.loops[0];
        if (outer && outer.length >= 2) {
          this.run({ profile: s.profile, pathPoints: outer.map((p): [number, number, number] => [p[0], p[1], p[2]]), closed: true });
          return;
        }
      }
    }
    if (hit && hit.ref.kind === 'sketchEdge' && this.inContext(hit.ref)) this.extend(s, hit.ref.id);
    if (!s.edgeIds.length) return;
    this.run({ profile: s.profile, pathEdgeIds: s.edgeIds as number[], closed: s.start !== null && s.start === s.end });
  }

  onCancel(): void {
    this.state = { kind: 'pickProfile' };
    this.lastError = null;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    if (!this.ctx) return [];
    const out: OverlayPrimitive[] = [];
    const state = stateOf(this.ctx);
    const s = this.state;
    const pathIds = this.pathEdgeIds;
    const path = this.ctx ? hostOfTool(this.ctx).context.path : [];
    for (const id of pathIds) out.push(...entityOverlay(state, { kind: 'sketchEdge', path, id }, PATH_COLOR));
    if (s.kind === 'path') {
      const pp = s.profile.path as Id[];
      const ref: EntityRef = s.profile.kind === 'sketchFace' ? { kind: 'sketchFace', path: pp, id: s.profile.id as Id } : { kind: 'face', path: pp, id: s.profile.id as Id, faceId: s.profile.faceId as FaceLocalId, region: s.profile.region };
      out.push(...entityOverlay(state, ref, HOVER_COLOR));
    } else if (this.hoverRef && (this.hoverRef.kind === 'face' || this.hoverRef.kind === 'sketchFace')) {
      out.push(...entityOverlay(state, this.hoverRef, HOVER_COLOR));
    }
    return out;
  }

  status(): ToolStatus {
    if (this.lastError) return { instructor: `Follow Me failed: ${this.lastError}`, vcbLabel: '' };
    if (this.state.kind === 'pickProfile') {
      return { instructor: this.preset.length ? `Click the profile face to sweep along the ${this.preset.length} selected edges.` : 'Click the profile face (preselect path edges to sweep immediately).', vcbLabel: '' };
    }
    return { instructor: `Hover or drag along the path edges (${this.state.edgeIds.length} so far) and click to finish. Alt + click a face uses its perimeter.`, vcbLabel: '' };
  }

  // --- internals ------------------------------------------------------------------------------

  /** Append a sketch edge to the chain when it continues it (or starts it). */
  private inContext(ref: EntityRef): boolean {
    return !!this.ctx && samePath(ref.path, hostOfTool(this.ctx).context.path);
  }

  private extend(s: Extract<State, { kind: 'path' }>, id: Id): void {
    if (!this.ctx || s.edgeIds.includes(id)) return;
    const e = rootOf(this.ctx).sketch.edges.get(id);
    if (!e) return;
    if (!s.edgeIds.length) {
      s.edgeIds.push(id);
      s.start = e.a;
      s.end = e.b;
    } else if (s.start === s.end) {
      return; // closed already
    } else if (e.a === s.end || e.b === s.end) {
      s.edgeIds.push(id);
      s.end = e.a === s.end ? e.b : e.a;
    } else if (e.a === s.start || e.b === s.start) {
      s.edgeIds.unshift(id);
      s.start = e.a === s.start ? e.b : e.a;
    } else return;
    this.ctx.statusChanged();
  }

  private run(params: FollowMeParams): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.state = { kind: 'pickProfile' };
    this.preset = [];
    this.queue = this.queue
      .then(async () => {
        await ctx.commands.execute('followme.apply', params);
      })
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      })
      .then(() => {
        ctx.statusChanged();
        ctx.requestRender();
      });
    ctx.statusChanged();
    ctx.requestRender();
  }
}
