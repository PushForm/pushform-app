// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Angle at p between the directions to q and r. */
export function cornerAngle(
  px: number,
  py: number,
  pz: number,
  qx: number,
  qy: number,
  qz: number,
  rx: number,
  ry: number,
  rz: number,
): number {
  const ux = qx - px,
    uy = qy - py,
    uz = qz - pz;
  const vx = rx - px,
    vy = ry - py,
    vz = rz - pz;
  const d =
    (ux * vx + uy * vy + uz * vz) / ((Math.hypot(ux, uy, uz) || 1) * (Math.hypot(vx, vy, vz) || 1));
  return Math.acos(Math.max(-1, Math.min(1, d)));
}
