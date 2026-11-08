// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterAll, describe, expect, it } from 'vitest';
import { HARDWARE_SHAPES, resolveHardwareOptions } from '../../hardware';
import { KernelClient } from '../../client/KernelClient';
import { InlineBackend } from '../../backends/InlineBackend';
import { meshTopologyProblems } from '../../meshChecks';

const client = new KernelClient(new InlineBackend());
afterAll(() => client.dispose());
describe('hardware solid families', () => {
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
