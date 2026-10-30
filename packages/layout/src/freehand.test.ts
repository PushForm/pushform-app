// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutFreehand } from './freehand';
import { flattenLayoutPath, type PaperPathPoint as Point } from './path';

it('reduces a noisy arc to smooth editable curves while retaining endpoints', () => {
  const samples: Point[] = Array.from({ length: 101 }, (_, i) => {
    const angle = i * Math.PI / 100, jitter = i % 2 ? 0.1 : -0.1;
    return [30 * Math.cos(angle), (30 + jitter) * Math.sin(angle)];
  });
  const original = structuredClone(samples);
  const path = createLayoutFreehand(samples, 0.5);
  expect(path.points.length).toBeGreaterThan(3);
  expect(path.points.length).toBeLessThan(20);
  expect(path.points[0]).toEqual(samples[0]);
  expect(path.points.at(-1)).toEqual(samples.at(-1));
  expect(path.closed).toBe(false);
  expect(path.handles?.[0]?.in).toBeUndefined();
  expect(path.handles?.at(-1)?.out).toBeUndefined();
  path.points.slice(1, -1).forEach((p, i) => {
    const h = path.handles![i + 1]!;
    expect(h.in![0] + h.out![0]).toBeCloseTo(2 * p[0]);
    expect(h.in![1] + h.out![1]).toBeCloseTo(2 * p[1]);
  });
  for (const p of flattenLayoutPath(path.points, path.handles, false)) {
    expect(Math.abs(Math.hypot(...p) - 30)).toBeLessThan(0.6);
  }
  expect(samples).toEqual(original);
});

it('removes jitter from straight strokes and ignores duplicate-only input', () => {
  const samples: Point[] = [[0, 0], [0, 0], [1, 0.1], [2, -0.1], [3, 0], [3, 0]];
  expect(createLayoutFreehand(samples, 0.2)).toEqual({ points: [[0, 0], [3, 0]], closed: false });
  for (const input of [[], [[1, 1]], [[1, 1], [1, 1]]] as Point[][]) {
    expect(createLayoutFreehand(input, 0.2).points).toEqual([]);
  }
  expect(createLayoutFreehand([[0, 0], [2, 1]], 0.2).points).toEqual([[0, 0], [2, 1]]);
});

it('retains loops and reversals without spikes or automatic closure', () => {
  const loop = createLayoutFreehand([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], 0.2);
  expect(loop.points).toHaveLength(5);
  expect(loop.closed).toBe(false);
  const reversal = createLayoutFreehand([[0, 0], [10, 0], [1, 0], [0, 0]], 0.2);
  expect(reversal.points).toEqual([[0, 0], [10, 0], [0, 0]]);
  const samples = flattenLayoutPath(reversal.points, reversal.handles, false);
  expect(samples.every(p => Number.isFinite(p[0]) && p[0] >= 0 && p[0] <= 10 && p[1] === 0)).toBe(true);
});

it('produces equivalent smoothing when paper scale and tolerance change together', () => {
  const samples: Point[] = [[0, 0], [1, 0.1], [2, 1], [3, 2], [4, 2.1], [5, 2]];
  const path = createLayoutFreehand(samples, 0.2);
  const scaled = createLayoutFreehand(samples.map(([x, y]) => [x * 4, y * 4]), 0.8);
  expect(scaled.points.map(([x, y]) => [x / 4, y / 4])).toEqual(path.points);
  scaled.handles?.forEach((h, i) => {
    for (const side of ['in', 'out'] as const) {
      if (h[side]) expect(h[side]!.map(v => v / 4)).toEqual(path.handles![i]![side]);
    }
  });
});

it('handles a long stroke without recursive stack growth and rejects invalid geometry', () => {
  const samples: Point[] = Array.from({ length: 20000 }, (_, i) => [i / 10, Math.sin(i / 100)]);
  expect(createLayoutFreehand(samples, 0.2).points.length).toBeLessThan(1000);
  expect(() => createLayoutFreehand([[Infinity, 0]], 0.2)).toThrow('Invalid freehand');
  expect(() => createLayoutFreehand([[0, 0]], -1)).toThrow('Invalid freehand');
});
