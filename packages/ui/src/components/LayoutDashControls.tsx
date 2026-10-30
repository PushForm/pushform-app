// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
import { LAYOUT_DASH_PATTERNS, layoutDashMm, matchLayoutDash } from '@pushform/layout';

/**
 * Stroke patterns and pattern scale. Dash lengths that are not a preset pattern, such
 * as DXF linetypes, show as Custom until another pattern is chosen.
 */
export function LayoutDashControls({ dashMm, weightPt, label = 'Dash', onChange }: {
  dashMm: readonly number[] | undefined; weightPt: number; label?: string; onChange(dashMm: number[]): void;
}): JSX.Element {
  const match = dashMm?.length ? matchLayoutDash(dashMm, weightPt) : null;
  const value = !dashMm?.length ? 'solid' : match ? String(match.id) : 'custom';
  return <>
    <label>{label}<select value={value} onChange={event => onChange(event.target.value === 'solid' ? [] : layoutDashMm(Number(event.target.value), weightPt, match?.scale ?? 1))}>
      <option value="solid">Solid</option>
      {LAYOUT_DASH_PATTERNS.map(pattern => <option key={pattern.id} value={pattern.id}>{pattern.name}</option>)}
      {value === 'custom' ? <option value="custom" disabled>Custom</option> : null}
    </select></label>
    {match ? <label>{label} scale<input type="number" min="0.1" step="0.25" value={+match.scale.toFixed(3)} onChange={event => {
      const scale = Number(event.target.value);
      if (scale > 0) onChange(layoutDashMm(match.id, weightPt, scale));
    }} /></label> : null}
  </>;
}
