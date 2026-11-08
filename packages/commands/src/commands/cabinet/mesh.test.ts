// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterAll, describe, expect, it } from 'vitest';
import { meshSignedVolume } from '@pushform/core';
import type { MeshData } from '@pushform/core';
import { InlineBackend, KernelClient, validateSolidMesh } from '@pushform/kernel';
import { DocumentHost } from '../../host/DocumentHost';
import { bodyFromMesh } from '@pushform/model';
import { cabinetPartMesh } from './generate';
import { meshLoftedPanel, meshStock } from './mesh';
import { planCabinet } from './plan';
import { inches as i } from './dimensions';

const kernels: KernelClient[] = [];
afterAll(() => { for (const k of kernels) k.dispose(); });

function expectClosed(mesh: MeshData): void {
  const directed = new Map<string, number>();
  const t = mesh.tris;
  for (let f = 0; f < t.length; f += 3) for (let k = 0; k < 3; k++) {
    const key = `${t[f + k]!},${t[f + (k + 1) % 3]!}`;
    directed.set(key, (directed.get(key) ?? 0) + 1);
  }
  for (const [key, count] of directed) {
    const [u, v] = key.split(',');
    expect(count, key).toBe(1);
    expect(directed.get(`${v},${u}`), key).toBe(1);
  }
}

describe('cabinet part meshes', () => {
  it('cuts a notch and a groove from stock, keeping the solid closed and the volume exact', () => {
    const mesh = meshStock([10, 4, 1], [{ min: [0, 0, 0], max: [2, 1, 1] }, { min: [0, 3, 0.25], max: [10, 4, 0.75] }]);
    expectClosed(mesh);
    expect(meshSignedVolume(mesh)).toBeCloseTo(40 - 2 - 5, 9);
  });

  it('builds a raised panel with the volume of its sections', () => {
    const mesh = meshLoftedPanel(10, 6, [[1, 0], [1, 1], [0, 1], [0, 2], [1, 2], [2, 3]]);
    expectClosed(mesh);
    const bevel = (8 * 4 + 4 * 7 * 3 + 6 * 2) / 6;
    expect(meshSignedVolume(mesh)).toBeCloseTo(8 * 4 + 60 + bevel, 9);
  });

  it('makes every part of every door style a solid the kernel accepts', async () => {
    const kernel = new KernelClient(new InlineBackend());
    kernels.push(kernel);
    let bodyId = 1;
    for (const doorStyle of ['slab', 'shaker', 'raised'] as const) {
      for (const part of planCabinet({ type: 'base', width: i(36), doorStyle, frame: 'face_frame' }).parts) {
        const mesh = cabinetPartMesh(part);
        expectClosed(mesh);
        await expect(validateSolidMesh(mesh), part.name).resolves.toBeUndefined();
        expect(meshSignedVolume(mesh), part.name).toBeGreaterThan(0);
        await kernel.ensureBody(bodyId++, 0, mesh);
      }
    }
  });

  it('gives a notched and rabbeted side one face per flat, with no extra edges', () => {
    const side = planCabinet({ type: 'base', width: i(24) }).parts.find(p => p.name === 'Left Side')!;
    const host = new DocumentHost();
    let faces = 0, edges = 0;
    host.edit('test', (draft) => {
      const body = bodyFromMesh(draft, cabinetPartMesh(side), { regroupFaces: true });
      faces = body.faces.size;
      edges = body.edges.size;
    });
    // A block has 6 faces; the through notch and the rabbet each add 2.
    expect(faces).toBe(10);
    expect(edges).toBe(24);
  });
});
