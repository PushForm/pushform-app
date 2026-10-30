// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect } from 'vitest';
import { meshBox, planeBasis, type MeshData, type Vec3 } from '@pushform/core';
import { meshTopologyProblems } from '../meshChecks';
import type { KernelClient } from '../client/KernelClient';
import type { KernelComponent, MeshWire, PolygonsWithHoles, PushPullRegion } from '../protocol';

/** Closed, consistently oriented, positive volume, and accepted by Manifold (status NoError). */
export async function expectManifold(client: KernelClient, mesh: MeshData | MeshWire): Promise<void> {
  expect(meshTopologyProblems(mesh)).toEqual([]);
  const wire: MeshWire = { verts: mesh.verts, tris: mesh.tris, faceId: mesh.faceId, runId: 0 };
  const r = await client.fromTriangles({ mesh: wire, nextFaceId: 1 });
  expect(r.status).toBe('NoError');
}

export const faceIds = (mesh: MeshData | MeshWire): number[] => [...new Set(mesh.faceId)].sort((a, b) => a - b);
export const faceCount = (mesh: MeshData | MeshWire): number => new Set(mesh.faceId).size;

/** Upload a fresh body and return its ref; versions start at 1. */
export async function uploadBox(client: KernelClient, bodyId: number, min: Vec3, max: Vec3): Promise<{ bodyId: number; version: number; mesh: MeshData }> {
  const mesh = meshBox(min, max);
  await client.ensureBody(bodyId, 1, mesh);
  return { bodyId, version: 1, mesh };
}

/** Upload a component returned by an op as the next version of a body. */
export async function uploadComponent(client: KernelClient, bodyId: number, version: number, c: KernelComponent): Promise<{ bodyId: number; version: number }> {
  await client.ensureBody(bodyId, version, c.mesh);
  return { bodyId, version };
}

/** Axis-aligned square of side `size` centred at (cx, cy) in the basis' (u,v). */
export function square(cx: number, cy: number, size: number): PolygonsWithHoles {
  const h = size / 2;
  return [[[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]]];
}

/** Region on the +z face of a unit box (face id 1 in `meshBox`), basis origin at the face centre. */
export function topRegion(origin: Vec3, polygon: PolygonsWithHoles, faceId: number, regionIsWholeFace: boolean): PushPullRegion {
  return { faceId, basis: planeBasis(origin, [0, 0, 1]), polygon, regionIsWholeFace };
}
