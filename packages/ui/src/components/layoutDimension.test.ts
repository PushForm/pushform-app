// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { createAngularDimension, createLinearDimension, type LayoutEntity } from '@pushform/layout';
import { paintAngularDimension, paintLayoutDimension } from './layoutDimension';

it('paints dimension lines, extensions, endpoints, and a visible detached cached measurement', () => {
  const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), closePath: vi.fn(), setLineDash: vi.fn(),
    translate: vi.fn(), rotate: vi.fn(), fillText: vi.fn<(text: string, x: number, y: number) => void>(), font: '', fillStyle: '', strokeStyle: '' };
  const entity: LayoutEntity = { id: 1, kind: 'dimension', layerId: 1, points: [[10, 10], [110, 10], [60, 25]],
    closed: false, dimension: { ...createLinearDimension(), cachedValueMm: 100, detached: true } };
  paintLayoutDimension(ctx as unknown as CanvasRenderingContext2D, entity);
  expect(ctx.lineTo).toHaveBeenCalledWith(110, 25);
  expect(ctx.lineTo).toHaveBeenCalledWith(10, 27);
  expect(ctx.fillText).toHaveBeenCalledWith('⚠ 100.0 mm', 0, -1);
  expect(ctx.strokeStyle).toBe('#c43b32');
  expect(ctx.fill).toHaveBeenCalledTimes(2);
  expect(ctx.restore).toHaveBeenCalledOnce();
});

it('paints the angular arc and detached angle text', () => {
  const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), closePath: vi.fn(), setLineDash: vi.fn(),
    fillText: vi.fn<(text: string, x: number, y: number) => void>(), font: '', fillStyle: '', strokeStyle: '' };
  paintAngularDimension(ctx as unknown as CanvasRenderingContext2D, {
    id: 1, kind: 'angular-dimension', layerId: 1, closed: false,
    points: [[0, 0], [20, 0], [0, 20], [10, 0]],
    angularDimension: { ...createAngularDimension(), cachedAngleDeg: 90, detached: true },
  });
  expect(ctx.arc).toHaveBeenCalledWith(0, 0, 10, 0, Math.PI / 2, false);
  expect(ctx.fillText.mock.calls[0]?.[0]).toBe('⚠ 90.0°');
  expect(ctx.strokeStyle).toBe('#c43b32');
});
