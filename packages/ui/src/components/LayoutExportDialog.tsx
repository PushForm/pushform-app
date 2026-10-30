// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from '@tauri-apps/api/core';
import type { LayoutDocumentState } from '@pushform/layout';
import { chooseSaveTarget } from '../saveFile';
import { exportLayoutImages, LAYOUT_IMAGE_RESOLUTIONS, layoutImageExportName, layoutImageSize, type LayoutImageFormat } from './layoutImageExport';
import { exportLayoutPdf, pdfPageRange } from './layoutPdfExport';
import { exportLayoutVectors } from './layoutVectorExport';
import { encodeLayoutArchiveSync, layoutJson, exportSketchUpLayout, type LayoutExportArea } from '@pushform/io';
import { rasterizeImage } from '../rasterizeImage';
import type { LayoutPagePainter } from './layoutPrint';

/** One export setup for LayOut documents, raster images and vector drawings. */
export function LayoutExportDialog({ state, activePageId, documentName, paint, onClose }: {
  state: LayoutDocumentState; activePageId: number; documentName: string; paint: LayoutPagePainter; onClose: () => void;
}): JSX.Element {
  const [scope, setScope] = useState<'all' | 'current' | 'range'>('all');
  const [format, setFormat] = useState<LayoutImageFormat | 'svg' | 'dxf' | 'layout' | 'pdf' | 'pfl'>('png');
  const [range, setRange] = useState('1');
  const [dpi, setDpi] = useState<number>(150);
  const [area, setArea] = useState<LayoutExportArea>('page');
  const [scale, setScale] = useState('1');
  // PDF: JPEG compression of images and showing the result.
  const [jpeg, setJpeg] = useState(false);
  const [jpegQuality, setJpegQuality] = useState(0.8);
  const [showAfter, setShowAfter] = useState(true);
  const [warnings, setWarnings] = useState<string[]>([]);
  const native = format === 'pfl';
  const entireDocument = native || format === 'layout';
  const vector = format === 'svg' || format === 'dxf';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const job = useRef<AbortController | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  let rangeError: string | null = null;
  let ids = scope === 'all' ? state.pageOrder : [activePageId];
  if (format === 'pdf' && scope === 'range') {
    try { ids = pdfPageRange(state.pageOrder, range); } catch (cause) { rangeError = (cause as Error).message; }
  }
  const page = state.pages.get(ids[0]!)!;
  const [width, height] = layoutImageSize(page.size, dpi);
  const mixed = ids.some(id => state.pages.get(id)!.size.some((value, index) => value !== page.size[index]));
  const name = native ? `${documentName.replace(/\.(pfl|layout)$/i, '') || 'Untitled'}.pfl` : format === 'pdf' ? `${documentName.replace(/\.(pfl|layout)$/i, '') || 'Untitled'}.pdf` : format === 'layout' ? `${documentName.replace(/\.(pfl|layout)$/i, '') || 'Untitled'}.layout` : layoutImageExportName(documentName, state, ids, format);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app');
    const wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    dialog.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
    const keydown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); job.current?.abort(); closeRef.current(); }
      if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [...dialog.current!.querySelectorAll<HTMLElement>('input:not([type=radio]):not(:disabled), input:checked:not(:disabled), select:not(:disabled), button:not(:disabled)')];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => {
      job.current?.abort();
      window.removeEventListener('keydown', keydown, true);
      if (app) app.inert = wasInert;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const exportFile = async () => {
    if (job.current) return;
    const controller = new AbortController(); job.current = controller;
    setBusy(true); setError(null); setWarnings([]);
    // A browser lets a click open a tab; opened now, the tab shows the PDF once it is written.
    const viewer = format === 'pdf' && showAfter && !isTauri() ? (window.open?.('', '_blank') ?? null) : null;
    let shown = false;
    try {
      // Ask first: browsers open their save picker only right after a click, and large pages take a while to paint.
      if (format === 'dxf' && (!Number.isFinite(Number(scale)) || Number(scale) <= 0)) throw new Error('Enter a positive drawing scale denominator.');
      if (rangeError) throw new Error(rangeError);
      const zip = format !== 'pdf' && !entireDocument && ids.length > 1;
      const target = await chooseSaveTarget(name, zip ? { description: 'ZIP archive', mime: 'application/zip', extension: 'zip' }
        : native ? { description: 'PushForm Layout', mime: 'application/octet-stream', extension: 'pfl' }
        : format === 'pdf' ? { description: 'PDF document', mime: 'application/pdf', extension: 'pdf' }
        : format === 'layout' ? { description: 'SketchUp LayOut', mime: 'application/octet-stream', extension: 'layout' }
        : format === 'svg' ? { description: 'SVG drawing', mime: 'image/svg+xml', extension: 'svg' }
        : format === 'dxf' ? { description: 'DXF drawing', mime: 'application/dxf', extension: 'dxf' }
        : format === 'png' ? { description: 'PNG image', mime: 'image/png', extension: 'png' } : { description: 'JPEG image', mime: 'image/jpeg', extension: 'jpg' });
      if (!target || controller.signal.aborted) return;
      const file = format === 'pfl' ? { bytes: encodeLayoutArchiveSync(layoutJson(state)), warnings: [] } : format === 'pdf' ? await exportLayoutPdf(state, ids, documentName, dpi, controller.signal, { jpegQuality: jpeg ? jpegQuality : undefined }) : format === 'layout' ? await exportSketchUpLayout(state, { rasterize: rasterizeImage }) : format === 'svg' || format === 'dxf'
        ? await exportLayoutVectors(state, ids, documentName, { format, area, scale: Number(scale) }, controller.signal)
        : await exportLayoutImages(state, ids, documentName, { format, dpi }, paint, controller.signal);
      if (!file || controller.signal.aborted) return;
      await target.write(file.bytes);
      if (controller.signal.aborted) return;
      if (format === 'pdf' && showAfter) {
        if (viewer) {
          const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: 'application/pdf' }));
          viewer.location.href = url;
          setTimeout(() => URL.revokeObjectURL(url), 300_000);
        } else await target.open?.();
        shown = true;
      }
      if (file.warnings?.length) setWarnings(file.warnings);
      else closeRef.current();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!shown) viewer?.close();
      job.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return createPortal(<div className="pf-layout-print-backdrop">
    <div ref={dialog} className="pf-layout-print-dialog" role="dialog" aria-modal="true" aria-label="Export">
      <h2>Export</h2>
      {!entireDocument ? <fieldset disabled={busy}><legend>Pages</legend>
        <label><input type="radio" name="image-export-pages" checked={scope === 'all'} onChange={() => setScope('all')} />All pages</label>
        <label><input type="radio" name="image-export-pages" checked={scope === 'current'} onChange={() => setScope('current')} />Current page ({state.pages.get(activePageId)!.name})</label>
        {format === 'pdf' ? <><label><input type="radio" name="image-export-pages" checked={scope === 'range'} onChange={() => setScope('range')} />Range</label><label>Page range <input aria-label="Page range" value={range} onChange={event => { setRange(event.target.value); setScope('range'); }} /></label></> : null}
      </fieldset> : null}
      <label>Format <select aria-label="Format" value={format} disabled={busy} onChange={event => { setFormat(event.target.value as LayoutImageFormat | 'svg' | 'dxf' | 'layout' | 'pdf' | 'pfl'); if (event.target.value === 'pdf') setDpi(300); else if (scope === 'range') setScope('all'); }}>
        <option value="pfl">PushForm Layout (.pfl)</option><option value="pdf">PDF</option><option value="layout">SketchUp LayOut (.layout)</option><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="svg">SVG</option><option value="dxf">DXF</option>
      </select></label>
      {native ? <p>Exports the entire document as an editable PushForm Layout file.</p> : format === 'layout' ? <p>Exports the entire document as an editable SketchUp LayOut file.</p> : !vector ? <label>Resolution <select aria-label="Resolution" value={dpi} disabled={busy} onChange={event => setDpi(Number(event.target.value))}>
        {(format === 'pdf' ? [150, 300] : LAYOUT_IMAGE_RESOLUTIONS).map(value => <option key={value} value={value}>{value} dpi</option>)}
      </select></label> : <label>Area <select aria-label="Area" value={area} disabled={busy} onChange={event => setArea(event.target.value as LayoutExportArea)}>
        <option value="page">Full page</option><option value="drawing">Drawing only</option>
      </select></label>}
      {format === 'pdf' ? <>
        <label><input type="checkbox" aria-label="JPEG compression" checked={jpeg} disabled={busy} onChange={event => setJpeg(event.target.checked)} />JPEG compression</label>
        {jpeg ? <label>Smaller file <input type="range" aria-label="JPEG quality" min="0.1" max="1" step="0.05" value={jpegQuality} disabled={busy} onChange={event => setJpegQuality(Number(event.target.value))} /> Better quality</label> : null}
        <label><input type="checkbox" aria-label="Show the PDF after export" checked={showAfter} disabled={busy} onChange={event => setShowAfter(event.target.checked)} />Show the PDF after export</label>
      </> : null}
      {format === 'dxf' ? <><label>Drawing scale 1:<input aria-label="Drawing scale denominator" type="number" min="0" step="any" value={scale} disabled={busy} onChange={event => setScale(event.target.value)} /></label>
        <p>DXF uses millimeters. Pictures and model views are omitted. Text may use substitute CAD fonts; dimensions, labels, and tables become geometry and text. Clipping is not retained.</p></> : null}
      <p role="status">{entireDocument ? 'Entire document' : format === 'pdf' ? `${ids.length} page(s) · PDF` : vector ? `${area === 'page' ? 'Full page' : 'Drawing only'} · ${format.toUpperCase()}` : `${width} × ${height} px${ids.length > 1 ? ` per page${mixed ? ' for the first page' : ''}` : ''}`} · {name}</p>
      {warnings.length ? <div role="status"><p>Export saved with notes:</p><ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div> : null}
      {error || rangeError ? <p role="alert">{error ?? rangeError}</p> : null}
      <div className="pf-layout-print-actions"><button type="button" onClick={() => { job.current?.abort(); onClose(); }}>{warnings.length ? 'Close' : 'Cancel'}</button>
        <button type="button" disabled={busy || !!rangeError} onClick={() => { void exportFile(); }}>{busy ? 'Exporting…' : 'Export…'}</button></div>
    </div>
  </div>, document.body);
}
