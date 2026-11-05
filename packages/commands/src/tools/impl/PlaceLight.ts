// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import type { SceneLightPatch } from '../../commands/environment';
import type { Tool, ToolContext, ToolPointerEvent } from '../Tool';
import type { OverlayPrimitive } from '../overlay';
import { inferenceOverlay } from '../toolUtil';

/** One click places a point light; spot and area lights use a second click to aim it. */
export class PlaceLightTool implements Tool {
  readonly id = 'placeLight';
  readonly title = 'Place Light';
  readonly cursor = 'crosshair';
  private ctx: ToolContext | null = null;
  private position: Vec3 | null = null;
  private pointer: ToolPointerEvent | null = null;
  private options: SceneLightPatch = {};
  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.position = null;
    this.pointer = null;
    this.options =
      (ctx.commands.ctx.services.get('sceneLightPlacement') as SceneLightPatch | undefined) ?? {};
    ctx.commands.ctx.services.delete('sceneLightPlacement');
  }
  deactivate(): void {
    this.onCancel();
    this.ctx = null;
  }
  onCancel(): void {
    this.position = null;
    this.pointer = null;
    this.ctx?.requestRender();
  }
  hasPendingWork(): boolean {
    return this.position !== null;
  }
  onPointerMove(event: ToolPointerEvent): void {
    this.pointer = event;
    this.ctx?.requestRender();
  }
  onPointerDown(event: ToolPointerEvent): void {
    const point = event.inference?.point;
    if (!point || event.button !== 0 || !this.ctx) return;
    if (!this.position && this.options.type && this.options.type !== 'point') {
      this.position = [...point];
      this.ctx.statusChanged();
      return;
    }
    const position = this.position ?? [...point];
    if (this.position && point.every((n, i) => n === position[i])) return;
    const params = {
      ...this.options,
      position,
      target: this.position ? [...point] : [position[0], position[1], position[2] - 1],
    };
    const ctx = this.ctx;
    const result = ctx.commands.tryExecute('light.create', params);
    if (result.ok) ctx.commands.ctx.tools?.activate('select');
  }
  overlay(): readonly OverlayPrimitive[] {
    const event = this.pointer,
      point = event?.inference?.point;
    return [
      ...(event ? inferenceOverlay(event.inference, event.screen) : []),
      ...(this.position && point
        ? [
            {
              kind: 'polyline' as const,
              points: [this.position, point],
              color: '#e7af39',
              width: 2,
            },
          ]
        : []),
    ];
  }
  status() {
    return {
      instructor: this.position
        ? 'Click the point the light should aim at. Escape cancels.'
        : 'Click to place the light. Escape cancels.',
      vcbLabel: '',
    };
  }
}
