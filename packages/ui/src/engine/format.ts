// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { METERS_PER, formatArea, formatLength } from '@pushform/core';
import type { UnitSettings } from '@pushform/core';

export { formatArea, formatLength };

type VolumeUnit = UnitSettings['volumeUnit'];

const M3_PER: Record<VolumeUnit, number> = {
  'in³': METERS_PER.in ** 3,
  'ft³': METERS_PER.ft ** 3,
  'yd³': METERS_PER.yd ** 3,
  'mm³': METERS_PER.mm ** 3,
  'cm³': METERS_PER.cm ** 3,
  'm³': 1,
  l: 0.001,
};

/** Cubic meters → the document's volume unit with its precision (e.g. `35.31 ft³`). */
export function formatVolume(m3: number, u: UnitSettings): string {
  const v = m3 / M3_PER[u.volumeUnit];
  return `${v.toFixed(u.volumePrecision)}${u.displayUnitSuffix ? ' ' + u.volumeUnit : ''}`;
}

/** `[r, g, b]` in 0..1 → CSS hex. */
export function rgbToCss(rgb: readonly [number, number, number]): string {
  const h = (c: number) =>
    Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}
