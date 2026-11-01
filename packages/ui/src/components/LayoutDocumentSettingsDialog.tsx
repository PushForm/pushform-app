// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { layoutGridUnits, layoutPaperUnits, type LayoutDocumentState } from '@pushform/layout';
import { PAPER_PRESETS, formatPaperLength, paperPresetFor, presetSizeMm, toMm, type PaperUnit } from './layoutPaper';

/**
 * Document Settings: the document's paper size, margin and grid, in a modal dialog opened from the object
 * browser or command search. Every page shares the paper; each change applies at once as its own undoable command.
 */
export function LayoutDocumentSettingsDialog({ state, onCommand, onClose }: {
  state: LayoutDocumentState;
  onCommand: (id: string, params: object) => void;
  onClose: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app');
    const wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    dialog.current?.querySelector<HTMLElement>('select, input')?.focus();
    // Keys stay in the dialog: workspace shortcuts never see them, and Tab cycles through its controls.
    const keydown = (event: KeyboardEvent): void => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [...dialog.current!.querySelectorAll<HTMLElement>('select, input, button')];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      if (app) app.inert = wasInert;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const paper = state.pages.get(state.pageOrder[0]!)!;
  const paperUnit: PaperUnit = layoutPaperUnits(state), gridUnit: PaperUnit = layoutGridUnits(state);
  const portrait = paper.size[1] > paper.size[0];
  const preset = paperPresetFor(paper.size);
  return createPortal(<div className="pf-layer-scope-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="pf-layer-scope-dialog pf-document-settings" role="dialog" aria-modal="true" aria-labelledby="pf-document-settings-title">
      <h2 id="pf-document-settings-title">Document Settings</h2>
      <fieldset>
        <legend>Paper</legend>
        <label>Paper size<select value={preset?.id ?? 'custom'} onChange={event => {
          // A preset fills in its landscape size and sets its standard's units for the paper, the grid and drawing values.
          const chosen = PAPER_PRESETS.find(item => item.id === event.target.value);
          if (!chosen) return;
          const [widthMm, heightMm] = presetSizeMm(chosen);
          onCommand('layout.document.setup', { widthMm, heightMm, units: chosen.unit, gridUnits: chosen.unit });
        }}>
          <option value="custom" disabled>Custom</option>
          {(['US', 'International'] as const).map(standard => <optgroup key={standard} label={standard}>
            {PAPER_PRESETS.filter(item => item.standard === standard).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </optgroup>)}
        </select></label>
        <label>Orientation<select value={portrait ? 'portrait' : 'landscape'} disabled={paper.size[0] === paper.size[1]} onChange={event => {
          // Turning the page swaps its width and height.
          if ((event.target.value === 'portrait') !== portrait) onCommand('layout.document.setup', { widthMm: paper.size[1], heightMm: paper.size[0] });
        }}>
          <option value="landscape">Landscape</option>
          <option value="portrait">Portrait</option>
        </select></label>
        <LengthField label="Page width" mm={paper.size[0]} unit={paperUnit} onCommit={widthMm => onCommand('layout.document.setup', { widthMm })} />
        <LengthField label="Page height" mm={paper.size[1]} unit={paperUnit} onCommit={heightMm => onCommand('layout.document.setup', { heightMm })} />
        <LengthField label="Margin" mm={paper.margin.left} unit={paperUnit} allowZero onCommit={marginMm => onCommand('layout.document.setup', { marginMm })} />
        <UnitField label="Page size units" unit={paperUnit} onChange={units => onCommand('layout.document.setup', { units })} />
      </fieldset>
      <fieldset>
        <legend>Grid</legend>
        <label><input type="checkbox" checked={state.settings.grid.show}
          onChange={event => onCommand('layout.grid.set', { show: event.target.checked })} />Show grid</label>
        <label><input type="checkbox" checked={state.settings.grid.snap}
          onChange={event => onCommand('layout.grid.set', { snap: event.target.checked })} />Snap to grid</label>
        <LengthField label="Grid size" mm={state.settings.grid.spacingMm} unit={gridUnit} onCommit={spacingMm => onCommand('layout.grid.set', { spacingMm })} />
        <UnitField label="Grid units" unit={gridUnit} onChange={units => onCommand('layout.grid.set', { units })} />
      </fieldset>
      <div className="pf-layer-scope-actions"><button type="button" onClick={onClose}>Close</button></div>
    </div>
  </div>, document.body);
}

/**
 * A length shown in `unit`. Typing keeps the text as entered (so "8." can become "8.5") and commits each valid value in
 * millimeters; the field shows the document's value again whenever it changes from elsewhere or loses focus.
 */
function LengthField({ label, mm, unit, allowZero = false, onCommit }: {
  label: string; mm: number; unit: PaperUnit; allowZero?: boolean; onCommit: (mm: number) => void;
}): JSX.Element {
  const shown = formatPaperLength(mm, unit);
  const [text, setText] = useState(shown);
  const focused = useRef(false);
  // A new unit always rewrites the text, even mid-edit, so the number never disagrees with its label.
  const shownUnit = useRef(unit);
  useEffect(() => {
    if (!focused.current || shownUnit.current !== unit) setText(shown);
    shownUnit.current = unit;
  }, [shown, unit]);
  // A text field keeps unfinished entries such as "8." that a number field would read as empty.
  return <label>{label} ({unit})<input type="text" inputMode="decimal" value={text}
    onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; setText(shown); }}
    onChange={event => {
      setText(event.target.value);
      const value = Number(event.target.value);
      if (event.target.value.trim() && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)) onCommit(toMm(value, unit));
    }} /></label>;
}

function UnitField({ label, unit, onChange }: { label: string; unit: PaperUnit; onChange: (unit: PaperUnit) => void }): JSX.Element {
  return <label>{label}<select value={unit} onChange={event => onChange(event.target.value as PaperUnit)}>
    <option value="in">in</option>
    <option value="mm">mm</option>
  </select></label>;
}
