// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
import type { PaperSnapKind } from '@pushform/layout';

/** Half the marker's box, in CSS pixels; large enough for the triangle. */
const R = 6;

/**
 * The dot, triangle, or square at the tracked placement point, drawn as SVG over the page canvas
 * so it stays crisp and the same size on screen at any zoom. x and y are CSS pixels from the page's corner.
 */
export function LayoutPlacementMarker({ snapKind, x, y }: { snapKind: PaperSnapKind | null; x: number; y: number }): JSX.Element {
  const fill = snapKind === 'endpoint' ? '#16a34a'
    : snapKind === 'on-path' ? '#dc2626'
      : snapKind === 'midpoint' ? '#9333ea' : '#1e63d1';
  return <svg className="pf-layout-placement-marker" data-snap={snapKind ?? 'none'} aria-hidden="true"
    width={2 * R} height={2 * R} viewBox={`${-R} ${-R} ${2 * R} ${2 * R}`} style={{ left: x - R, top: y - R }}>
    {snapKind === 'midpoint'
      // Centered on the precise snap position.
      ? <polygon points="0,-5.4 4.68,2.7 -4.68,2.7" fill={fill} />
      : snapKind === 'on-path'
        ? <rect x={-3.9} y={-3.9} width={7.8} height={7.8} fill={fill} />
        : <circle r={snapKind ? 3.9 : 2.4} fill={fill} />}
  </svg>;
}
