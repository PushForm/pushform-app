// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { LayoutDocumentState } from '@pushform/layout';
import { printLayoutDocument, type LayoutPagePainter } from './layoutPrint';

export function LayoutPrintDialog({ state, activePageId, title, paint, imageVersion, onClose }: {
  state: LayoutDocumentState; activePageId: number; title: string; paint: LayoutPagePainter;
  imageVersion: number; onClose: () => void;
}): JSX.Element {
  const [scope, setScope] = useState<'all' | 'current'>('all');
  const [dpi, setDpi] = useState(300);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const job = useRef<AbortController | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const ids = scope === 'all' ? state.pageOrder : [activePageId];
  const page = state.pages.get(ids[0]!)!;
  const scale = Math.min(420 / page.size[0], 230 / page.size[1]);
  useEffect(() => {
    if (preview.current) paint(preview.current, page, state, 96);
  }, [page, state, paint, imageVersion]);
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
        const controls = [...dialog.current!.querySelectorAll<HTMLElement>('input:checked:not(:disabled), select:not(:disabled), button:not(:disabled)')];
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
  const print = async () => {
    if (job.current) return;
    const controller = new AbortController(); job.current = controller;
    setBusy(true); setError(null);
    try {
      await printLayoutDocument(state, [...ids], title, paint, dpi, controller.signal);
      if (!controller.signal.aborted) closeRef.current();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      job.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return createPortal(<div className="pf-layout-print-backdrop">
    <div ref={dialog} className="pf-layout-print-dialog" role="dialog" aria-modal="true" aria-label="Print Layout">
      <h2>Print Layout</h2>
      <div className="pf-layout-print-preview"><canvas ref={preview} aria-label={`Print preview: ${page.name}`}
        style={{ width: page.size[0] * scale, height: page.size[1] * scale }} /></div>
      <p>{ids.length} {ids.length === 1 ? 'page' : 'pages'} · {page.size[0]} × {page.size[1]} mm{ids.some(id => state.pages.get(id)!.size.some((value, index) => value !== page.size[index])) ? ' · Mixed paper sizes' : ''}</p>
      <fieldset disabled={busy}><legend>Pages</legend>
        <label><input type="radio" name="print-pages" checked={scope === 'all'} onChange={() => setScope('all')} />All pages</label>
        <label><input type="radio" name="print-pages" checked={scope === 'current'} onChange={() => setScope('current')} />Current page ({state.pages.get(activePageId)!.name})</label>
      </fieldset>
      <label>Print quality <select aria-label="Print quality" value={dpi} disabled={busy} onChange={event => setDpi(Number(event.target.value))}>
        <option value={300}>High (300 dpi)</option><option value={150}>Standard (150 dpi)</option>
      </select></label>
      <p className="pf-layout-print-hint">For physical scale, choose 100% / Actual size, matching paper, no margins, and no headers or footers in the print dialog.</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="pf-layout-print-actions"><button type="button" onClick={() => { job.current?.abort(); onClose(); }}>Cancel</button>
        <button type="button" disabled={busy} onClick={() => { void print(); }}>{busy ? 'Preparing…' : 'Print…'}</button></div>
    </div>
  </div>, document.body);
}
