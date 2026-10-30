// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { formatLength, type UnitSettings } from '@pushform/core';
import { MESH_FORMATS_WITH_UP_AXIS, MESH_UNITS, meshPointConverter, type MeshExtent, type MeshFormatKind, type MeshImportOptions, type MeshUnit } from '@pushform/io';

const LABELS: Record<MeshFormatKind, string> = { obj: 'OBJ', '3ds': '3DS', stl: 'STL', dxf: 'DXF' };

/**
 * Units and up axis for an OBJ, 3DS, STL or unitless DXF import, with the model's width, depth and
 * height as they would import, so a wrong unit or axis shows before anything is imported.
 */
export function MeshImportDialog({ fileName, kind, extent, initial, units, onCancel, onImport }: {
  fileName: string; kind: MeshFormatKind; extent: MeshExtent | null; initial: MeshImportOptions; units: UnitSettings;
  onCancel: () => void; onImport: (options: MeshImportOptions) => void;
}): JSX.Element {
  const [unit, setUnit] = useState<MeshUnit>(initial.unit);
  const asksUp = MESH_FORMATS_WITH_UP_AXIS.includes(kind);
  const [up, setUp] = useState<'z' | 'y'>(asksUp ? initial.up : 'z');
  const dialog = useRef<HTMLDivElement>(null), cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app'), wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    dialog.current?.querySelector<HTMLElement>('select')?.focus();
    const keydown = (event: KeyboardEvent): void => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); cancel.current(); }
      if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [...dialog.current!.querySelectorAll<HTMLElement>('select, input:checked[type="radio"], button')];
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
  let size = 'Size unknown: the file has no vertices to measure.';
  if (extent) {
    const { point } = meshPointConverter({ unit, up }), a = point(extent.min), b = point(extent.max);
    const [width, depth, height] = [0, 1, 2].map(k => Math.abs(b[k]! - a[k]!)).map(meters => formatLength(meters, units));
    size = `Size: ${width} wide × ${depth} deep × ${height} high`;
  }
  return createPortal(<div className="pf-modal-backdrop">
    <div ref={dialog} className="pf-modal pf-mesh-import-dialog" role="dialog" aria-modal="true" aria-labelledby="mesh-import-title" aria-describedby="mesh-import-size">
      <h2 id="mesh-import-title">Import {LABELS[kind]}</h2>
      <p className="pf-options-hint">{fileName} does not record its units{asksUp ? ' or which axis is up' : ''}.</p>
      <label>Units<select value={unit} onChange={event => setUnit(event.target.value as MeshUnit)}>
        {MESH_UNITS.map(item => <option key={item.unit} value={item.unit}>{item.label}</option>)}
      </select></label>
      {asksUp ? <fieldset><legend>Up axis</legend>
        <label><input type="radio" name="mesh-up" checked={up === 'z'} onChange={() => setUp('z')} />Z up</label>
        <label><input type="radio" name="mesh-up" checked={up === 'y'} onChange={() => setUp('y')} />Y up</label>
      </fieldset> : null}
      <p id="mesh-import-size" role="status">{size}</p>
      <div className="pf-modal-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" onClick={() => onImport({ unit, up })}>Import</button></div>
    </div>
  </div>, document.body);
}
