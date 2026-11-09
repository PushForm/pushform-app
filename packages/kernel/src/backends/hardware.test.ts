// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterAll, describe, expect, it } from 'vitest';
import { HARDWARE_SHAPES, resolveHardwareOptions } from '../hardware';
import { KernelClient } from '../client/KernelClient';
import { InlineBackend } from './InlineBackend';
import { meshTopologyProblems } from '../meshChecks';

const client = new KernelClient(new InlineBackend());
afterAll(() => client.dispose());
describe('hardware solid families', () => {
  it('keeps revolved dome dimensions and a bounded mesh across density settings', async () => {
    for (const [segments, profileSegments, budget] of [
      [40, 20, 2000],
      [80, 32, 5200],
      [16, 8, 300],
    ] as const) {
      const r = await client.hardware({
        options: {
          shape: 'knob-domed',
          width: 0.0381,
          projection: 0.03175,
          grip: 0.017,
          segments,
          profileSegments,
        },
        nextFaceId: 1,
      });
      expect(r.components).toHaveLength(1);
      const mesh = r.components[0]!.mesh;
      expect(meshTopologyProblems(mesh)).toEqual([]);
      expect(mesh.tris.length / 3).toBeLessThan(budget);
      for (const [axis, size] of [
        [0, 0.0381],
        [1, 0.0381],
        [2, 0.03175],
      ] as const) {
        const coords = Array.from(mesh.verts).filter((_, i) => i % 3 === axis);
        expect(Math.max(...coords) - Math.min(...coords)).toBeCloseTo(size, 6);
      }
      expect(r.mountingCenters).toEqual([[0, 0, 0]]);
    }
  });
  it('rejects invalid dome tessellation and a base wider than the head', () => {
    for (const profileSegments of [7, 33, 8.5, NaN])
      expect(() => resolveHardwareOptions({ shape: 'knob-domed', profileSegments })).toThrow();
    expect(() =>
      resolveHardwareOptions({ shape: 'knob-domed', grip: 0.04, width: 0.032 }),
    ).toThrow();
  });
  for (const shape of HARDWARE_SHAPES)
    it(`creates closed positive-volume ${shape}`, async () => {
      const result = await client.hardware({
        options: {
          shape,
          ...(shape === 'ring' ? { width: 0.05 } : {}),
          ...(['cup', 'cup-square'].includes(shape) ? { width: 0.035 } : {}),
        },
        nextFaceId: 1,
      });
      expect(result.components.length).toBeGreaterThan(0);
      for (const c of result.components) {
        expect(c.props.volume).toBeGreaterThan(0);
        expect(meshTopologyProblems(c.mesh)).toEqual([]);
        expect(Array.from(c.mesh.verts).every(Number.isFinite)).toBe(true);
      }
      expect(result.components.reduce((n, c) => n + c.mesh.tris.length / 3, 0)).toBeLessThan(12000);
    });
  it('preserves exact mounting spacing and overall bar dimensions', async () => {
    const r = await client.hardware({
      options: { shape: 'bar-round', length: 0.15, spacing: 0.128, grip: 0.01 },
      nextFaceId: 1,
    });
    expect(r.mountingCenters[1]![0] - r.mountingCenters[0]![0]).toBeCloseTo(0.128, 12);
    const xs = Array.from(r.components[0]!.mesh.verts).filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.15, 6);
  });
  it('rejects inconsistent geometry and non-finite input before construction', () => {
    expect(() => resolveHardwareOptions({ shape: 'wire', spacing: 0.2, length: 0.1 })).toThrow();
    expect(() => resolveHardwareOptions({ shape: 'cup', wall: 0.02 })).toThrow();
    expect(() => resolveHardwareOptions({ shape: 'knob-round', width: NaN })).toThrow();
  });
});

it('keeps a ball ahead of its mounting face and joins the ring to its mount', async () => {
  const ball = await client.hardware({ options: { shape: 'knob-ball' }, nextFaceId: 1 });
  expect(
    Math.min(...Array.from(ball.components[0]!.mesh.verts).filter((_, i) => i % 3 === 2)),
  ).toBeGreaterThanOrEqual(0);
  const ring = await client.hardware({ options: { shape: 'ring' }, nextFaceId: 1 });
  expect(ring.components).toHaveLength(1);
  const zs = Array.from(ring.components[0]!.mesh.verts).filter((_, i) => i % 3 === 2);
  expect(Math.max(...zs)).toBeCloseTo(ring.resolved.projection, 5);
});
it('uses independent arch length and grip width at maximum resolution', async () => {
  const r = await client.hardware({
    options: {
      shape: 'arch',
      length: 0.13335,
      spacing: 0.096,
      width: 0.01429,
      grip: 0.008,
      projection: 0.028575,
      segments: 80,
    },
    nextFaceId: 1,
  });
  const mesh = r.components[0]!.mesh;
  const axis = (a: number) => Array.from(mesh.verts).filter((_, i) => i % 3 === a);
  expect(Math.max(...axis(0)) - Math.min(...axis(0))).toBeCloseTo(0.13335, 5);
  expect(Math.max(...axis(1)) - Math.min(...axis(1))).toBeCloseTo(0.01429, 5);
  expect(mesh.tris.length / 3).toBeLessThan(12000);
});
it('rejects closed pocket and ring openings', () => {
  expect(() =>
    resolveHardwareOptions({ shape: 'recessed-round', width: 0.01, wall: 0.003 }),
  ).toThrow();
  expect(() => resolveHardwareOptions({ shape: 'ring', width: 0.02, grip: 0.012 })).toThrow();
});
for (const shape of HARDWARE_SHAPES)
  it(`bounds the high-resolution ${shape} preview budget`, async () => {
    const r = await client.hardware({ options: { shape, segments: 80 }, nextFaceId: 1 });
    expect(r.components.reduce((n, c) => n + c.mesh.tris.length / 3, 0)).toBeLessThan(12000);
    for (const c of r.components) expect(meshTopologyProblems(c.mesh)).toEqual([]);
  });
