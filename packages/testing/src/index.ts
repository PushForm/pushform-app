// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// @pushform/testing: Mesh assertions, fixtures, golden files
import { expect } from 'vitest';
import type { MeshData } from '@pushform/core';
import { meshTopologyProblems } from '@pushform/kernel';

export const PACKAGE = '@pushform/testing';

/** Assert a mesh is a closed, consistently oriented solid with positive volume (see `meshTopologyProblems`). */
export function expectManifold(mesh: MeshData): void {
  expect(meshTopologyProblems(mesh)).toEqual([]);
}

/** Assert the signed volume of a mesh within `digits` decimal places. */
export function expectVolume(mesh: MeshData, volume: number, digits = 6): void {
  let v = 0;
  const p = mesh.verts, t = mesh.tris;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]! * 3, b = t[i + 1]! * 3, c = t[i + 2]! * 3;
    v +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) +
      p[a + 1]! * (p[b + 2]! * p[c]! - p[b]! * p[c + 2]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  expect(v / 6).toBeCloseTo(volume, digits);
}
