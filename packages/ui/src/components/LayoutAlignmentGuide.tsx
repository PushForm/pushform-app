// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';

/** Padding around the guide's box, in CSS pixels, so its stroke is not clipped. */
const PAD = 2;

/**
 * The dotted guide from a reference vertex to a point lined up with it: red when horizontal, green when
 * vertical, drawn as SVG over the page canvas so it stays one screen pixel wide at any zoom. from and to
 * are CSS pixels from the page's corner.
 */
export function LayoutAlignmentGuide({ axis, from, to }: {
  axis: 'horizontal' | 'vertical'; from: readonly [number, number]; to: readonly [number, number];
}): JSX.Element {
  const left = Math.min(from[0], to[0]) - PAD, top = Math.min(from[1], to[1]) - PAD;
  const width = Math.abs(to[0] - from[0]) + 2 * PAD, height = Math.abs(to[1] - from[1]) + 2 * PAD;
  return <svg className="pf-layout-alignment-guide" data-axis={axis} aria-hidden="true"
    width={width} height={height} style={{ left, top }}>
    <line x1={from[0] - left} y1={from[1] - top} x2={to[0] - left} y2={to[1] - top}
      stroke={axis === 'horizontal' ? '#dc2626' : '#16a34a'} strokeWidth={1} strokeDasharray="3 3" />
  </svg>;
}
