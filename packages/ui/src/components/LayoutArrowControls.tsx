// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
import { LAYOUT_ARROW_LABELS, LAYOUT_ARROW_TYPES, LAYOUT_DEFAULT_ARROW_SIZE_PT, type LayoutArrow, type LayoutArrowType } from '@pushform/layout';

/**
 * Start and end arrows for an open shape or the default style: None or a LayOut arrow style, and a size
 * in points once an arrow is chosen. `onChange` receives null to remove an arrow.
 */
export function LayoutArrowControls({ startArrow, endArrow, onChange }: {
  startArrow: LayoutArrow | undefined; endArrow: LayoutArrow | undefined;
  onChange(change: { startArrow?: LayoutArrow | null; endArrow?: LayoutArrow | null }): void;
}): JSX.Element {
  const control = (key: 'startArrow' | 'endArrow', label: string, arrow: LayoutArrow | undefined) => <>
    <label>{label}<select value={arrow?.type ?? 'none'} onChange={event => onChange({ [key]: event.target.value === 'none' ? null
      : { type: event.target.value as LayoutArrowType, sizePt: arrow?.sizePt ?? LAYOUT_DEFAULT_ARROW_SIZE_PT } })}>
      <option value="none">None</option>
      {LAYOUT_ARROW_TYPES.map(type => <option key={type} value={type}>{LAYOUT_ARROW_LABELS[type]}</option>)}
    </select></label>
    {arrow ? <label>{label} size (pt)<input type="number" min="0.5" step="0.5" value={arrow.sizePt} onChange={event => {
      const sizePt = Number(event.target.value);
      if (sizePt > 0 && sizePt <= 1000) onChange({ [key]: { ...arrow, sizePt } });
    }} /></label> : null}
  </>;
  return <>
    {control('startArrow', 'Start arrow', startArrow)}
    {control('endArrow', 'End arrow', endArrow)}
  </>;
}
