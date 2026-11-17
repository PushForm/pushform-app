// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Axis } from '@pushform/inference';

/** Axis names as the model's colours. */
const AXIS_NAME: Readonly<Record<Axis, string>> = { x: 'red', y: 'green', z: 'blue' };

/** Tag for a direction locked to an axis with an arrow key. */
export function axisTag(axis: Axis | null | undefined): string[] {
  return axis ? [`On ${AXIS_NAME[axis]} axis`] : [];
}

/** Tag for a drawing plane locked square to an axis with an arrow key. */
export function planeTag(axis: Axis | null | undefined): string[] {
  return axis ? [`Plane square to ${AXIS_NAME[axis]} axis`] : [];
}

/** Tag for an inference direction or plane held with Shift. */
export const SHIFT_HELD = 'Held direction · Shift';

/** Tag for the Down-arrow lock parallel or perpendicular to an edge. */
export const EDGE_LOCKED = 'Parallel or perpendicular to edge · ↓';
