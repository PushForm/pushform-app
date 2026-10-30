// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { formatLength, parseLength } from '@pushform/core';
import type { UnitSettings } from '@pushform/core';
import { TEXT3D_FONT_NAMES, TEXT3D_FONTS } from '@pushform/commands';
import type { Text3DAlign, Text3DFont } from '@pushform/commands';
import { useApp } from '../AppContext';
import { noticeFromError } from '../hooks/useCommandNotices';
import { Check, Dialog, Field } from './DialogParts';

/** The dialog's last entries, kept for the next 3D text in this session (lengths in meters). */
interface Text3DEntries {
  text: string;
  font: Text3DFont;
  bold: boolean;
  align: Text3DAlign;
  height: number | null;
  filled: boolean;
  extruded: boolean;
  extrude: number | null;
}
let last: Text3DEntries = { text: '', font: 'sans', bold: false, align: 'left', height: null, filled: true, extruded: true, extrude: null };

const METRIC = new Set(['mm', 'cm', 'm']);

/** First-use lengths: 1' high and 1" deep in imperial models, 300 mm and 30 mm in metric ones. */
function defaults(units: UnitSettings): { height: number; extrude: number } {
  return METRIC.has(units.lengthUnit) ? { height: 0.3, extrude: 0.03 } : { height: 0.3048, extrude: 0.0254 };
}

const ALIGNS: readonly { value: Text3DAlign; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];

/**
 * 3D Text: the text, font, Regular/Bold, alignment, height, Filled and Extruded. Place creates the
 * component and hands it to the cursor; a click places it.
 */
export function Text3DDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const app = useApp();
  const units = app.document.doc.state.meta.units;
  const first = defaults(units);
  const [text, setText] = useState(last.text);
  const [font, setFont] = useState<Text3DFont>(last.font);
  const [bold, setBold] = useState(last.bold);
  const [align, setAlign] = useState<Text3DAlign>(last.align);
  const [height, setHeight] = useState(() => formatLength(last.height ?? first.height, units));
  const [filled, setFilled] = useState(last.filled);
  const [extruded, setExtruded] = useState(last.extruded);
  const [extrude, setExtrude] = useState(() => formatLength(last.extrude ?? first.extrude, units));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const h = parseLength(height, units.lengthUnit);
    if (h === null || h <= 0) return setError('Enter a height greater than zero.');
    const d = parseLength(extrude, units.lengthUnit);
    const depth = filled && extruded ? d : 0;
    if (depth === null || (filled && extruded && depth === 0)) return setError('Enter an extrusion depth other than zero.');
    if (!text.trim()) return setError('Enter some text.');
    last = { text, font, bold, align, height: h, filled, extruded, extrude: d ?? last.extrude };
    setBusy(true);
    setError(null);
    try {
      await app.commands.execute('text3d.create', { text, font, bold, align, height: h, filled, extrude: depth });
      onClose();
    } catch (err) {
      setError(noticeFromError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Place 3D Text" onClose={onClose}>
      <form className="pf-dialog-form" onSubmit={(e) => void submit(e)}>
        <textarea
          id="pf-t3d-text"
          className="pf-dialog-input"
          aria-label="Text"
          rows={3}
          placeholder="Enter text"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Field label="Font" htmlFor="pf-t3d-font">
          <select id="pf-t3d-font" className="pf-dialog-input" value={font} onChange={(e) => setFont(e.target.value as Text3DFont)}>
            {TEXT3D_FONTS.map((f) => (
              <option key={f} value={f}>
                {TEXT3D_FONT_NAMES[f]}
              </option>
            ))}
          </select>
          <select className="pf-dialog-input" aria-label="Weight" value={bold ? 'bold' : 'regular'} onChange={(e) => setBold(e.target.value === 'bold')}>
            <option value="regular">Regular</option>
            <option value="bold">Bold</option>
          </select>
        </Field>
        <Field label="Align" htmlFor="pf-t3d-align">
          <select id="pf-t3d-align" className="pf-dialog-input" value={align} onChange={(e) => setAlign(e.target.value as Text3DAlign)}>
            {ALIGNS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Height" htmlFor="pf-t3d-height">
          <input id="pf-t3d-height" className="pf-dialog-input" value={height} onChange={(e) => setHeight(e.target.value)} />
        </Field>
        <fieldset className="pf-dialog-group">
          <legend>Form</legend>
          <div className="pf-dialog-checks">
            <Check id="pf-t3d-filled" label="Filled" checked={filled} onChange={setFilled} />
            <Check id="pf-t3d-extruded" label="Extruded" checked={filled && extruded} onChange={setExtruded} disabled={!filled} />
          </div>
          <Field label="Depth" htmlFor="pf-t3d-extrude">
            <input
              id="pf-t3d-extrude"
              className="pf-dialog-input"
              value={extrude}
              disabled={!(filled && extruded)}
              onChange={(e) => setExtrude(e.target.value)}
            />
          </Field>
        </fieldset>
        {error ? (
          <p className="pf-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="pf-dialog-actions">
          <button type="button" className="pf-dialog-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="pf-dialog-btn is-primary" disabled={busy}>
            Place
          </button>
        </div>
      </form>
    </Dialog>
  );
}
