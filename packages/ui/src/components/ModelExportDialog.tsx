// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { MESH_UNITS, type MeshUnit, type StlFormat } from '@pushform/io';
import { chooseSaveTarget } from '../saveFile';
import { keepProportions, modelImageFileName, modelImageSize, modelImageSizeError, renderModelImage, type ModelImageChoice, type ModelImageRenderer } from './modelImageExport';

export type ModelExportFormat = 'gltf' | 'obj' | 'collada';
export type ModelExportDialogFormat = ModelExportFormat | 'pf' | 'stl' | 'png' | 'jpeg' | 'image';
export interface ModelExportChoice { unit: MeshUnit; up: 'z' | 'y'; selectionOnly: boolean }
export interface StlExportChoice { unit: MeshUnit; format: StlFormat; selectionOnly: boolean }
let stlRemembered: { unit: MeshUnit; format: StlFormat } = { unit: 'mm', format: 'binary' };
let objRemembered: { unit: MeshUnit; up: 'z' | 'y' } = { unit: 'm', up: 'y' };
const HINTS = {
  gltf: 'glTF files are always in meters with Y up; textures are embedded in the .glb file.',
  obj: 'OBJ files store no unit. The .zip holds the .obj file with its .mtl material file and texture images.',
  collada: 'COLLADA files are written in meters with Z up; a model with textures is a .zip holding the .dae file and its images.',
  stl: 'STL files store no unit; most 3D printing software reads them as millimeters.',
};

/** The last choices, so the next export in this session starts from them. */
let remembered: Omit<ModelImageChoice, 'width' | 'height'> & { width: number | null } = { format: 'png', useViewSize: true, width: null, antialias: true, transparent: false };

/** One export setup for model geometry and viewport images. */
export function ModelExportDialog({ modelName, view, render, onClose, initialFormat, hasSelection, onGeometryExport, encodeNative }: {
  initialFormat: ModelExportDialogFormat; hasSelection: boolean; encodeNative: () => Uint8Array | Promise<Uint8Array>;
  onGeometryExport: (format: ModelExportFormat | 'stl', choice: ModelExportChoice, stlFormat: StlFormat) => void;
  modelName: string; view: { width: number; height: number }; render: ModelImageRenderer; onClose: () => void;
}): JSX.Element {
  const [format, setFormat] = useState<Exclude<ModelExportDialogFormat, 'image'>>(initialFormat === 'image' ? remembered.format : initialFormat);
  const image = format === 'png' || format === 'jpeg';
  const [stlUnit, setStlUnit] = useState(stlRemembered.unit);
  const [stlFormat, setStlFormat] = useState(stlRemembered.format);
  const [objUnit, setObjUnit] = useState(objRemembered.unit);
  const [up, setUp] = useState(objRemembered.up);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [useViewSize, setUseViewSize] = useState(remembered.useViewSize);
  const [width, setWidth] = useState(() => remembered.width ?? Math.max(1, Math.round(view.width)));
  const [height, setHeight] = useState(() => keepProportions('width', remembered.width ?? view.width, view));
  const [antialias, setAntialias] = useState(remembered.antialias);
  const [transparent, setTransparent] = useState(remembered.transparent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const open = useRef(true);
  const choice: ModelImageChoice = { format: format === 'jpeg' ? 'jpeg' : 'png', useViewSize, width, height, antialias, transparent };
  const [pixelsWide, pixelsHigh] = modelImageSize(choice, view);
  const tooLarge = image ? modelImageSizeError(pixelsWide, pixelsHigh) : null;
  const name = format === 'pf' ? `${modelName.replace(/\.pf$/i, '') || 'Untitled'}.pf` : modelImageFileName(modelName, choice.format);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app'), wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    dialog.current?.querySelector<HTMLElement>('select')?.focus();
    const keydown = (event: KeyboardEvent): void => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [...dialog.current!.querySelectorAll<HTMLElement>('select:not(:disabled), input:not(:disabled), button:not(:disabled)')];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
    };
    window.addEventListener('keydown', keydown, true);
    open.current = true;
    return () => {
      open.current = false;
      window.removeEventListener('keydown', keydown, true);
      if (app) app.inert = wasInert;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const changeSide = (side: 'width' | 'height', value: number): void => {
    if (!Number.isFinite(value)) return;
    const own = Math.max(1, Math.round(value)), other = keepProportions(side, own, view);
    if (side === 'width') { setWidth(own); setHeight(other); } else { setHeight(own); setWidth(other); }
  };
  const exportFile = async (): Promise<void> => {
    if (busy || tooLarge) return;
    setBusy(true); setError(null);
    if (image) remembered = { format: choice.format, useViewSize, width: useViewSize ? remembered.width : width, antialias, transparent };
    try {
      // Ask first: browsers open their save picker only right after a click.
      const target = await chooseSaveTarget(name, format === 'pf' ? { description: 'PushForm Model', mime: 'application/octet-stream', extension: 'pf' } : choice.format === 'png' ? { description: 'PNG image', mime: 'image/png', extension: 'png' }
        : { description: 'JPEG image', mime: 'image/jpeg', extension: 'jpg' });
      if (!target || !open.current) return;
      const bytes = format === 'pf' ? await encodeNative() : await renderModelImage(render, choice, view);
      if (!open.current) return;
      await target.write(bytes);
      closeRef.current();
    } catch (cause) {
      if (open.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (open.current) setBusy(false);
    }
  };
  const submit = (): void => {
    if (image || format === 'pf') { void exportFile(); return; }
    if (format === 'stl') stlRemembered = { unit: stlUnit, format: stlFormat };
    if (format === 'obj') objRemembered = { unit: objUnit, up };
    onGeometryExport(format, { unit: format === 'stl' ? stlUnit : objUnit, up, selectionOnly: hasSelection && selectionOnly }, stlFormat);
  };
  return createPortal(<div className="pf-modal-backdrop">
    <div ref={dialog} className="pf-modal pf-stl-export-dialog pf-image-export-dialog" role="dialog" aria-modal="true" aria-labelledby="image-export-title">
      <h2 id="image-export-title">Export</h2>
      <label>Format<select value={format} disabled={busy} onChange={event => setFormat(event.target.value as Exclude<ModelExportDialogFormat, 'image'>)}>
        <option value="pf">PushForm Model (.pf)</option><option value="stl">STL (.stl)</option><option value="gltf">glTF (.glb)</option><option value="obj">OBJ (.zip)</option><option value="collada">COLLADA (.dae)</option><option value="png">PNG</option><option value="jpeg">JPEG</option>
      </select></label>
      {format === 'pf' ? <p>Exports the entire document as an editable PushForm Model file.</p> : image ? <><label><input type="checkbox" checked={useViewSize} disabled={busy} onChange={event => setUseViewSize(event.target.checked)} />Use view size</label>
      <div className="pf-image-export-size">
        <label>Width<input type="number" min={1} step={1} value={useViewSize ? pixelsWide : width} disabled={busy || useViewSize}
          onChange={event => changeSide('width', event.target.valueAsNumber)} /></label>
        <label>Height<input type="number" min={1} step={1} value={useViewSize ? pixelsHigh : height} disabled={busy || useViewSize}
          onChange={event => changeSide('height', event.target.valueAsNumber)} /></label>
        <span>pixels</span>
      </div>
      <label><input type="checkbox" checked={antialias} disabled={busy} onChange={event => setAntialias(event.target.checked)} />Anti-alias</label>
      <label><input type="checkbox" checked={format === 'png' && transparent} disabled={busy || format !== 'png'}
        onChange={event => setTransparent(event.target.checked)} />Transparent background</label>
      <p role="status" className="pf-options-hint">{pixelsWide} × {pixelsHigh} px · {name}</p>
      </> : <>
        {format === 'stl' || format === 'obj' ? <label>Units<select value={format === 'stl' ? stlUnit : objUnit} onChange={event => {
          const unit = event.target.value as MeshUnit; if (format === 'stl') setStlUnit(unit); else setObjUnit(unit);
        }}>{MESH_UNITS.map(item => <option key={item.unit} value={item.unit}>{item.label}</option>)}</select></label> : null}
        {format === 'stl' ? <fieldset><legend>STL encoding</legend>
          <label><input type="radio" name="stl-format" checked={stlFormat === 'binary'} onChange={() => setStlFormat('binary')} />Binary</label>
          <label><input type="radio" name="stl-format" checked={stlFormat === 'ascii'} onChange={() => setStlFormat('ascii')} />ASCII</label>
        </fieldset> : null}
        {format === 'obj' ? <fieldset><legend>Up axis</legend>
          <label><input type="radio" name="obj-up" checked={up === 'y'} onChange={() => setUp('y')} />Y up</label>
          <label><input type="radio" name="obj-up" checked={up === 'z'} onChange={() => setUp('z')} />Z up</label>
        </fieldset> : null}
        <label><input type="checkbox" checked={hasSelection && selectionOnly} disabled={!hasSelection} onChange={event => setSelectionOnly(event.target.checked)} />Export selected geometry only</label>
        <p className="pf-options-hint">{HINTS[format]}</p>
      </>}
      {tooLarge ? <p role="alert">{tooLarge}</p> : error ? <p role="alert">{error}</p> : null}
      <div className="pf-modal-actions"><button type="button" onClick={onClose}>Cancel</button>
        <button type="button" disabled={busy || !!tooLarge} onClick={submit}>{busy ? 'Exporting…' : 'Export…'}</button></div>
    </div>
  </div>, document.body);
}
