// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import { m4transformDir, m4transformPoint, v3cross, v3normalize, v3sub } from '@pushform/core';
import { contextMatrix, instanceAt, containerAt, type DocumentState, type EntityRef } from '@pushform/model';
import { textLabelPoint } from '@pushform/render';

/** The view's right and up directions and its size in CSS px, which picking and editing texts need. */
export function viewAxesOf(cam: { eye: Vec3; target: Vec3; up: Vec3 }, width: number, height: number): { right: Vec3; up: Vec3; width: number; height: number } {
  const forward = v3normalize(v3sub(cam.target, cam.eye));
  const right = v3normalize(v3cross(forward, cam.up));
  return { right, up: v3cross(right, forward), width, height };
}

/**
 * Where a text's label is on screen (CSS px): its label point for leader text, its top-left corner for screen text; null
 * when the text no longer exists.
 */
export function textScreenPoint(
  state: DocumentState,
  ref: EntityRef,
  view: { right: Vec3; up: Vec3; width: number; height: number },
  project: (p: Vec3) => readonly [number, number],
): [number, number] | null {
  if (ref.kind !== 'text') return null;
  try {
    if (ref.path.length) instanceAt(state, ref.path);
  } catch {
    return null;
  }
  const t = containerAt(state, ref.path).texts.get(ref.id);
  if (!t) return null;
  if (t.kind === 'screen') return [t.position[0] * view.width, t.position[1] * view.height];
  const m = contextMatrix(state, ref.path);
  const label = textLabelPoint(
    { position: m4transformPoint(m, t.position), offset: t.offset && !t.viewOffset ? m4transformDir(m, t.offset) : null, viewOffset: t.viewOffset ?? null },
    view.right,
    view.up,
  );
  const [x, y] = project(label);
  return [x, y];
}
