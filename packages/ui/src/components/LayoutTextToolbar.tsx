// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState, type JSX } from 'react';
import { formatLayoutTextRange, layoutTextStyleAt, type LayoutLineSpacing, type LayoutText } from '@pushform/layout';
import { isDocumentToolbarTarget } from './toolbarFocus';
import { LayoutFontOptions } from './LayoutFontPicker';
import { Icon } from './Icon';

type Range = { start: number; end: number };
type Emphasis = 'bold' | 'italic' | 'underline';
function emphasisActive(text: LayoutText, range: Range, key: Emphasis): boolean {
  if (range.start === range.end) return layoutTextStyleAt(text, range.start)[key];
  for (let index = range.start; index < range.end; index++) if (!layoutTextStyleAt(text, index)[key]) return false;
  return true;
}

/** Contextual formatting in the right-side tool pane while an inline text editor is active. */
export function LayoutTextToolbar({ text, range, getSelection, onCaptureSelection, onChange, onReturnToText, onFinish }: {
  text: LayoutText; range: Range; getSelection: () => Range; onCaptureSelection: (range: Range) => void;
  onChange: (patch: Partial<LayoutText>, returnFocus?: boolean) => void;
  onReturnToText: () => void; onFinish: () => void;
}): JSX.Element {
  const selectedStyle = layoutTextStyleAt(text, range.start);
  const [size, setSize] = useState(String(selectedStyle.fontSizePt));
  useEffect(() => setSize(String(selectedStyle.fontSizePt)), [selectedStyle.fontSizePt]);
  return <div className="pf-layout-text-toolbar" role="group" aria-label="Text formatting"
    onPointerDownCapture={() => onCaptureSelection(getSelection())}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onFinish(); }
    }}
    onBlur={event => {
      const next = event.relatedTarget as HTMLElement | null;
      if (next && !isDocumentToolbarTarget(next) && !next.closest('.pf-layout-inline-text')) onFinish();
    }}>
    <select aria-label="Text toolbar font" title="Font family" value={selectedStyle.fontFamily}
      onChange={event => onChange(formatLayoutTextRange(text, getSelection(), { fontFamily: event.target.value }), false)}>
      <LayoutFontOptions value={selectedStyle.fontFamily} />
    </select>
    <label className="pf-layout-text-size"><input aria-label="Text toolbar size" title="Font size in points" type="number" min="1" step="0.5" value={size}
      onChange={event => { setSize(event.target.value); const value = Number(event.target.value); if (value >= 1 && Number.isFinite(value)) onChange(formatLayoutTextRange(text, getSelection(), { fontSizePt: value }), false); }}
      onBlur={() => setSize(String(selectedStyle.fontSizePt))}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onReturnToText(); } }} />pt</label>
    <span className="pf-layout-text-toolbar-divider" aria-hidden="true" />
    {(['bold', 'italic', 'underline'] as const).map(key => <button key={key} type="button" aria-label={`Text toolbar ${key}`}
      title={key[0]!.toUpperCase() + key.slice(1)} aria-pressed={emphasisActive(text, range, key)}
      onMouseDown={event => event.preventDefault()} onClick={() => onChange(formatLayoutTextRange(text, getSelection(), { [key]: !emphasisActive(text, getSelection(), key) }))}>
      <Icon name={`text-${key}`} size={16} />
    </button>)}
    <input className="pf-layout-text-color" aria-label="Text toolbar color" title="Text color" type="color" value={selectedStyle.color}
      onInput={event => onChange(formatLayoutTextRange(text, getSelection(), { color: event.currentTarget.value }), false)}
      onChange={event => onChange(formatLayoutTextRange(text, getSelection(), { color: event.target.value }), false)} />
    <span className="pf-layout-text-toolbar-divider" aria-hidden="true" />
    {(['left', 'center', 'right'] as const).map(align => <button key={align} type="button" title={`Align ${align}`}
      aria-label={`Text toolbar align ${align}`} aria-pressed={text.align === align}
      onMouseDown={event => event.preventDefault()} onClick={() => onChange({ align })}>
      <Icon name={`text-align-${align}`} size={16} />
    </button>)}
    <select aria-label="Text toolbar line spacing" title="Line spacing" value={lineSpacingKey(text.lineSpacing)}
      onChange={event => onChange({ lineSpacing: { mode: 'multiple', value: Number(event.target.value) } }, false)}>
      {LINE_SPACINGS.some(value => lineSpacingKey(text.lineSpacing) === String(value)) ? null
        : <option value={lineSpacingKey(text.lineSpacing)} disabled>{lineSpacingLabel(text.lineSpacing!)}</option>}
      {LINE_SPACINGS.map(value => <option key={value} value={String(value)}>{lineSpacingLabel({ mode: 'multiple', value })}</option>)}
    </select>
  </div>;
}

/** The multiples the toolbar offers; Single is 1. */
const LINE_SPACINGS = [0.8, 1, 1.15, 1.5, 2, 2.5, 3];

function lineSpacingKey(spacing: LayoutLineSpacing | undefined): string {
  return !spacing ? '1' : spacing.mode === 'multiple' ? String(spacing.value) : `${spacing.mode}:${spacing.value}`;
}

function lineSpacingLabel(spacing: LayoutLineSpacing): string {
  if (spacing.mode === 'exactly') return `Exactly ${spacing.value} pt`;
  if (spacing.mode === 'atLeast') return `At least ${spacing.value} pt`;
  return spacing.value === 1 ? 'Single' : `${spacing.value}×`;
}
