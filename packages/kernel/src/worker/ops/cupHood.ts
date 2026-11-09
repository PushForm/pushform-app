// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MeshData } from '@pushform/core';
import type { SimplePolygon } from 'manifold-3d';
import type { ResolvedHardwareOptions } from '../../hardware';

/** A curved open-bottom hood: a soft lower grip edge and rounded closed ends. */
export function rectangularCupHood(p: ResolvedHardwareOptions, inset: number, lip: number) {
  const l = p.length - 2 * inset,
    w = p.width,
    h = p.projection,
    t = p.wall;
  const base = Math.min(t * 0.8, h * 0.1),
    roll = Math.min(t * 0.4, (w - lip) * 0.05);
  const low = -w / 2,
    high = w / 2 - lip,
    span = high - low;
  const profile: SimplePolygon = [
    [low, 0],
    [low, h - roll],
  ];
  for (let i = 1; i <= 4; i++) {
    const a = (i * Math.PI) / 8;
    profile.push([low + roll - roll * Math.cos(a), h - roll + roll * Math.sin(a)]);
  }
  // A fourth-power profile keeps a broad face and a tighter shoulder than an ellipse.
  for (let i = 1; i <= 10; i++) {
    const a = ((1 - i / 10) * Math.PI) / 2;
    profile.push([
      low + roll + (span - roll) * Math.sqrt(Math.cos(a)),
      base + (h - base) * Math.sqrt(Math.sin(a)),
    ]);
  }
  profile.push([high, 0]);
  // Cross-sections use local Y for height and Z for projection.
  profile.reverse();
  const end = Math.min(2 * t, l * 0.025, w * 0.08, h * 0.08),
    rings: { x: number; offset: number }[] = [];
  for (let i = 4; i >= 0; i--) {
    const a = (i * Math.PI) / 8;
    rings.push({ x: -(l / 2 - end + end * Math.sin(a)), offset: end * (1 - Math.cos(a)) });
  }
  for (let i = 0; i <= 4; i++) {
    const a = (i * Math.PI) / 8;
    rings.push({ x: l / 2 - end + end * Math.sin(a), offset: end * (1 - Math.cos(a)) });
  }
  const verts: number[] = [],
    tris: number[] = [],
    count = profile.length,
    center = (low + high) / 2;
  for (const ring of rings)
    for (const [y, z] of profile)
      verts.push(
        ring.x,
        center + ((y - center) * (span - 2 * ring.offset)) / span,
        h / 2 + ((z - h / 2) * (h - 2 * ring.offset)) / h,
      );
  for (let k = 0; k < rings.length - 1; k++)
    for (let i = 0; i < count; i++) {
      const a = k * count + i,
        b = k * count + ((i + 1) % count);
      tris.push(a, b, b + count, a, b + count, a + count);
    }
  for (let i = 1; i < count - 1; i++) {
    tris.push(0, i + 1, i);
    const top = (rings.length - 1) * count;
    tris.push(top, top + i, top + i + 1);
  }
  const cavity: SimplePolygon = [
    [low - t, -t],
    [low - t, h - t],
    [low + roll, h - t],
  ];
  // A fourth-power profile keeps a broad face and a tighter shoulder than an ellipse.
  for (let i = 1; i <= 10; i++) {
    const a = ((1 - i / 10) * Math.PI) / 2;
    cavity.push([
      low + roll + (span - roll - t) * Math.sqrt(Math.cos(a)),
      base + (h - t - base) * Math.sqrt(Math.sin(a)),
    ]);
  }
  cavity.push([high - t, -t]);
  cavity.reverse();
  const mesh: MeshData = {
    verts: new Float64Array(verts),
    tris: new Uint32Array(tris),
    faceId: new Uint32Array(tris.length / 3),
  };
  return { mesh, cavity, interiorLength: l - 2 * Math.max(t * 1.5, end * 1.5) };
}
