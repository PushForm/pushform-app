// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { planeFromPointNormal, planeProject, v3dist, MERGE_TOL } from '@pushform/core';
import type { Plane, Vec2, Vec3 } from '@pushform/core';
import type { Axis, InferenceOptions, InferenceResult } from '@pushform/inference';
import { SNAP_COLORS } from '@pushform/inference';
import type { AddCurveInput, AddCurveResult } from '../../commands/curves';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { inferenceOverlay, PREVIEW_COLOR, screenDist } from '../toolUtil';
import { AXIS_NORMAL, drawingPlaneAt, planeLockFromKey, toggleLock } from './drawingUtil';

/** Minimum pointer travel (CSS px) between two samples. */
export const FREEHAND_SAMPLE_PX = 2;
/** Releasing within this many px of the first sample closes the curve (a face forms). */
const CLOSE_PX = 8;

/**
 * Freehand tool: press, drag, release → one freehand Curve (a welded polyline). Samples are taken
 * every 2 px of pointer travel and projected onto the drawing plane fixed at the press (hovered
 * face, arrow-key lock, else the inference plane). Releasing on the start closes the curve so a
 * face forms. Esc while dragging discards the stroke.
 */
export class FreehandTool implements Tool {
  readonly id = 'freehand';
  readonly title = 'Freehand';
  readonly cursor = 'crosshair';

  private ctx: ToolContext | null = null;
  private plane: Plane | null = null;
  private lockNormal: Axis | null = null;
  private samples: Vec3[] = [];
  private screens: Vec2[] = [];
  private drawing = false;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;
  private lastResult: AddCurveResult | null = null;

  get isDrawing(): boolean {
    return this.drawing;
  }
  get sampleCount(): number {
    return this.samples.length;
  }
  get planeLock(): Axis | null {
    return this.lockNormal;
  }
  get lastCurve(): AddCurveResult | null {
    return this.lastResult;
  }

  hasPendingWork(): boolean {
    return this.drawing;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
  }
  deactivate(): void {
    this.reset();
    this.lastResult = null;
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    let plane = this.plane;
    if (!plane && this.lockNormal) plane = planeFromPointNormal([0, 0, 0], AXIS_NORMAL[this.lockNormal]);
    // While drawing, only the plane matters: snapping every sample would make the stroke jitter.
    return { plane: plane ?? undefined, lockAxis: null, pickOnly: this.drawing };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    if (this.drawing && (e.buttons & 1) !== 0 && this.plane && e.inference) {
      const lastScreen = this.screens[this.screens.length - 1];
      if (!lastScreen || screenDist(lastScreen, e.screen) >= FREEHAND_SAMPLE_PX) {
        this.samples.push(planeProject(this.plane, e.inference.point));
        this.screens.push(e.screen);
      }
    }
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0 || !e.inference) return;
    const p = e.inference.point;
    this.plane = drawingPlaneAt(e.inference, p, this.lockNormal, null);
    this.samples = [p];
    this.screens = [e.screen];
    this.drawing = true;
    this.ctx?.statusChanged();
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.drawing) return;
    if (this.plane && e.inference) {
      const lastScreen = this.screens[this.screens.length - 1];
      if (!lastScreen || screenDist(lastScreen, e.screen) >= FREEHAND_SAMPLE_PX) {
        this.samples.push(planeProject(this.plane, e.inference.point));
        this.screens.push(e.screen);
      }
    }
    this.finish();
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    const lock = planeLockFromKey(e.key);
    if (lock === undefined) return false;
    this.lockNormal = toggleLock(this.lockNormal, lock);
    this.ctx?.requestRender();
    return true;
  }

  onCancel(): void {
    this.reset();
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    if (this.samples.length >= 2) out.push({ kind: 'polyline', points: this.samples, color: PREVIEW_COLOR, width: 2 });
    if (this.drawing && this.samples.length >= 3 && this.cursorScreen && this.screens[0] && screenDist(this.screens[0], this.cursorScreen) <= CLOSE_PX) {
      out.push({ kind: 'point', position: this.samples[0]!, color: SNAP_COLORS.endpoint, shape: 'circle', size: 8 });
    }
    if (!this.drawing) out.push(...inferenceOverlay(this.cursorInference, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    return this.drawing
      ? { instructor: 'Release to finish the curve (release on the start to close it).', vcbLabel: '' }
      : { instructor: 'Click and drag to draw a freehand curve.', vcbLabel: '' };
  }

  // --- internals ------------------------------------------------------------------------------

  private finish(): void {
    const samples = this.samples, screens = this.screens;
    const drawing = this.drawing;
    this.samples = [];
    this.screens = [];
    this.drawing = false;
    this.plane = null;
    if (!drawing || !this.ctx || samples.length < 2) {
      this.ctx?.statusChanged();
      return;
    }
    const first = samples[0]!, last = samples[samples.length - 1]!;
    const firstScreen = screens[0]!, lastScreen = screens[screens.length - 1]!;
    const closed = samples.length >= 3 && (screenDist(firstScreen, lastScreen) <= CLOSE_PX || v3dist(first, last) <= MERGE_TOL);
    // Closing: the last sample is the start again, so drop it and let the closing segment do it.
    const points = closed ? samples.slice(0, -1) : samples;
    const edgeCount = closed ? points.length : points.length - 1;
    if (edgeCount < 1 || (closed && points.length < 3)) return;
    const payload: AddCurveInput = { points, closed, curve: { kind: 'freehand', segments: edgeCount } };
    this.lastResult = this.ctx.commands.execute('sketch.addCurve', payload) as AddCurveResult;
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  private reset(): void {
    this.samples = [];
    this.screens = [];
    this.drawing = false;
    this.plane = null;
    this.lockNormal = null;
  }
}
