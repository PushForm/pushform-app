// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  LENGTH_TOL,
  m4identity,
  v3cross,
  v3dist,
  v3len,
  v3normalize,
  v3sub,
  type MeshData,
  type MMat4,
  type Vec3,
} from '@pushform/core';
import type { InferenceOptions } from '@pushform/inference';
import { containerAt, type EntityRef } from '@pushform/model';
import { contextFrame, samePath } from '../../commands/context';
import { resolveFaceTargetWorld, type FaceTarget } from '../../commands/offset';
import { runRevolveKernel, type RevolveParams, type RevolveWork } from '../../commands/revolve';
import { kernelOf } from '../../host/services';
import type { VcbValue } from '../../vcb/parse';
import type {
  Tool,
  ToolContext,
  ToolKeyEvent,
  ToolPointerEvent,
  ToolSettingValue,
  ToolStatus,
} from '../Tool';
import type { OverlayPrimitive } from '../overlay';
import { countFrom, countSetting } from '../settings';
import { entityOverlay, HOVER_COLOR, hostOfTool, inferenceOverlay } from '../toolUtil';
import { edgeSegment, faceTargetOfHit, stateOf } from './constructionUtil';
import { degreesFromVcb } from './drawingUtil';

type State =
  | { kind: 'profile' }
  | { kind: 'axis'; profile: FaceTarget; origin: Vec3 | null }
  | { kind: 'preview'; params: RevolveParams };

/** A profile, an in-plane axis (edge or two points), then a read-only solid preview. */
export class RevolveTool implements Tool {
  readonly id = 'revolve';
  readonly title = 'Revolve';
  readonly cursor = 'crosshair';
  readonly vcbSchema = ['angle', 'length', 'segments'] as const;
  private ctx: ToolContext | null = null;
  private state: State = { kind: 'profile' };
  private angle = 360;
  private segments = 48;
  private hover: EntityRef | null = null;
  private pointer: ToolPointerEvent | null = null;
  private work: RevolveWork | null = null;
  private error: string | null = null;
  private generation = 0;
  private busy = false;
  private queue: Promise<void> = Promise.resolve();
  get settled(): Promise<void> {
    return this.queue;
  }
  get previewMeshes(): readonly MeshData[] {
    return this.work && this.ctx && this.work.state === hostOfTool(this.ctx).doc.state
      ? this.work.result.components.map((c) => c.mesh)
      : [];
  }
  get previewMatrix(): MMat4 {
    return this.ctx
      ? contextFrame(stateOf(this.ctx), hostOfTool(this.ctx).context.path).matrix
      : m4identity();
  }
  hasPendingWork(): boolean {
    return this.state.kind !== 'profile';
  }
  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.onCancel();
  }
  deactivate(): void {
    this.onCancel();
    this.ctx = null;
  }
  inferenceOptions(): InferenceOptions {
    const s = this.state;
    if (s.kind === 'profile') return { pickOnly: true, kinds: ['face', 'sketchFace'] };
    if (s.kind === 'axis' && this.ctx)
      return {
        plane: resolveFaceTargetWorld(stateOf(this.ctx), s.profile).plane,
        ...(s.origin ? { anchor: s.origin } : {}),
      };
    return { pickOnly: true };
  }
  onPointerMove(e: ToolPointerEvent): void {
    this.pointer = e;
    this.hover = e.inference?.hit?.ref ?? null;
    this.ctx?.requestRender();
  }
  onClick(e: ToolPointerEvent): void {
    if (!this.ctx || e.button !== 0 || this.busy) return;
    const s = this.state;
    if (s.kind === 'preview') {
      this.apply();
      return;
    }
    const hit = e.inference?.hit ?? null;
    if (s.kind === 'profile') {
      const profile = faceTargetOfHit(stateOf(this.ctx), hit);
      if (!profile || !samePath(profile.path, hostOfTool(this.ctx).context.path)) return;
      this.state = { kind: 'axis', profile, origin: null };
      this.error = null;
    } else if (e.inference) {
      const segment = !s.origin && hit ? edgeSegment(stateOf(this.ctx), hit.ref) : null;
      if (segment) {
        if (hit?.ref.kind === 'edge') {
          const ref = hit.ref;
          const polyline =
            containerAt(stateOf(this.ctx), ref.path).bodies.get(ref.id)?.edges.get(ref.edgeKey)
              ?.polyline ?? [];
          const direction =
            polyline.length > 1
              ? v3normalize(v3sub(polyline[polyline.length - 1]!, polyline[0]!))
              : null;
          if (
            !direction ||
            polyline.some((p) => v3len(v3cross(v3sub(p, polyline[0]!), direction)) > LENGTH_TOL)
          ) {
            this.error = 'Choose a straight edge for the axis';
            this.changed();
            return;
          }
        }
        this.setAxis(s.profile, segment.a, segment.b);
      } else if (!s.origin) this.state = { ...s, origin: e.inference.point };
      else this.setAxis(s.profile, s.origin, e.inference.point);
    }
    this.changed();
  }
  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.key !== 'Enter' || this.state.kind !== 'preview') return false;
    this.apply();
    return true;
  }
  onVcb(value: VcbValue): void {
    if (value.kind === 'segments') {
      this.onSetting('segments', value);
      return;
    }
    const angle = degreesFromVcb(value);
    if (angle === null) return;
    if (!Number.isFinite(angle) || angle <= 0 || angle > 360) {
      this.error = 'Enter an angle greater than 0° and at most 360°';
      this.changed();
      return;
    }
    this.angle = angle;
    this.error = null;
    this.refresh();
  }
  onSetting(id: string, value: ToolSettingValue): void {
    if (id === 'apply') {
      this.apply();
      return;
    }
    if (id !== 'segments') return;
    const count = countFrom(value);
    if (count === null || !Number.isInteger(count) || count < 3 || count > 720) {
      this.error = 'Enter 3 to 720 segments per full turn';
      this.changed();
      return;
    }
    this.segments = count;
    this.error = null;
    this.refresh();
  }
  onCancel(): void {
    this.generation++;
    this.state = { kind: 'profile' };
    this.work = null;
    this.hover = null;
    this.pointer = null;
    this.error = null;
    this.changed();
  }
  overlay(): readonly OverlayPrimitive[] {
    if (!this.ctx) return [];
    const out: OverlayPrimitive[] = [];
    if (this.state.kind === 'profile' && this.hover)
      out.push(...entityOverlay(stateOf(this.ctx), this.hover, HOVER_COLOR));
    if (this.state.kind === 'axis' && this.state.origin && this.pointer?.inference)
      out.push({
        kind: 'polyline',
        points: [this.state.origin, this.pointer.inference.point],
        color: '#1565c0',
        width: 2,
      });
    if (this.state.kind === 'preview') {
      const p = this.state.params;
      out.push({
        kind: 'polyline',
        points: [
          p.axisOrigin,
          [
            p.axisOrigin[0] + p.axisDir[0],
            p.axisOrigin[1] + p.axisDir[1],
            p.axisOrigin[2] + p.axisDir[2],
          ],
        ],
        color: '#1565c0',
        width: 2,
      });
    }
    out.push(...inferenceOverlay(this.pointer?.inference ?? null));
    return out;
  }
  status(): ToolStatus {
    const s = this.state;
    const hint = this.busy
      ? 'Applying Revolve…'
      : s.kind === 'profile'
        ? 'Click the profile face.'
        : s.kind === 'axis'
          ? s.origin
            ? 'Click a second point to set the axis direction.'
            : 'Click a straight edge for the axis, or pick two points in the profile plane.'
          : this.work
            ? 'Check the preview, enter an angle, then click or press Enter to apply. Escape cancels.'
            : 'Preparing Revolve preview…';
    return {
      instructor: this.error ?? hint,
      vcbLabel: 'Angle',
      vcbValue: `${this.angle}°`,
      placing: s.kind === 'axis',
      fields:
        s.kind === 'preview'
          ? [{ id: 'angle', label: 'Angle', kind: 'angle', value: `${this.angle}°` }]
          : [],
      settings: [
        countSetting('segments', 'Segments', this.segments),
        {
          kind: 'action',
          id: 'apply',
          label: 'Apply',
          primary: true,
          disabled: !this.work || this.busy || !!this.error,
        },
      ],
    };
  }
  private setAxis(profile: FaceTarget, a: Vec3, b: Vec3): void {
    if (v3dist(a, b) <= LENGTH_TOL) {
      this.error = 'Pick two different points for the axis';
      return;
    }
    this.state = {
      kind: 'preview',
      params: {
        profile,
        axisOrigin: [...a],
        axisDir: v3sub(b, a),
        angleDeg: this.angle,
        segments: this.segments,
      },
    };
    this.refresh();
  }
  private refresh(): void {
    const ctx = this.ctx;
    if (!ctx || this.busy) return;
    if (this.state.kind !== 'preview') {
      this.changed();
      return;
    }
    const params = { ...this.state.params, angleDeg: this.angle, segments: this.segments };
    this.state = { kind: 'preview', params };
    this.error = null;
    const generation = ++this.generation;
    this.work = null;
    this.queue = this.queue.then(async () => {
      if (generation !== this.generation) return;
      try {
        const work = await runRevolveKernel(hostOfTool(ctx), kernelOf(ctx.commands.ctx), params);
        if (generation !== this.generation || this.ctx !== ctx) return;
        this.work = work;
      } catch (error) {
        if (generation === this.generation)
          this.error = error instanceof Error ? error.message : String(error);
      }
      this.changed();
    });
    this.changed();
  }
  private apply(): void {
    const ctx = this.ctx,
      work = this.work;
    if (!ctx || !work || this.busy || this.error) return;
    this.busy = true;
    const generation = this.generation;
    this.queue = this.queue.then(async () => {
      try {
        if (generation !== this.generation || this.ctx !== ctx) return;
        await ctx.commands.execute('revolve.apply', { ...work.params, precomputed: work });
        if (generation === this.generation) this.onCancel();
      } catch (error) {
        if (generation === this.generation)
          this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.busy = false;
        this.changed();
      }
    });
    this.changed();
  }
  private changed(): void {
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
    this.ctx?.overlayChanged?.();
  }
}
