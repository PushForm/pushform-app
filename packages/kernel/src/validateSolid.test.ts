// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox } from '@pushform/core';
import { validateSolidMesh } from './validateSolid';
describe('uncached solid validation', () => {
  it('validates repeatedly without modifying canonical Float64 geometry', async () => {
    const mesh = meshBox([1e9, 0, 0], [1e9 + 1.123456789, 2, 3]);
    const before = { verts: mesh.verts.slice(), tris: mesh.tris.slice(), faceId: mesh.faceId.slice() };
    for (let i = 0; i < 10; i++) await validateSolidMesh(mesh);
    expect(mesh).toEqual(before);
  });
  it('rejects open, empty, malformed and cancelled meshes', async () => {
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    await expect(validateSolidMesh({ ...mesh, tris: mesh.tris.slice(3), faceId: mesh.faceId.slice(1) })).rejects.toThrow();
    await expect(validateSolidMesh({ verts: new Float64Array(), tris: new Uint32Array(), faceId: new Uint32Array() })).rejects.toThrow();
    const invalid = mesh.verts.slice(); invalid[0] = Infinity;
    await expect(validateSolidMesh({ ...mesh, verts: invalid })).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(validateSolidMesh(mesh, controller.signal)).rejects.toThrow();
  });
});
