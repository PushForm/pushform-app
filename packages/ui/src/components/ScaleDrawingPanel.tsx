// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type JSX } from 'react';
import { drawingSketchPaths, visibleDrawingEntities, type DrawingPlane, type LayoutEntity } from '@pushform/layout';
import type { DocumentSession, LayoutTab } from '../session';

export function ScaleDrawingPanel({ tab, session }: { tab: LayoutTab; session: DocumentSession }): JSX.Element | null {
  const [dialog, setDialog] = useState<'layout' | 'model' | number | null>(null);
  const [error, setError] = useState('');
  const views = [...(tab.doc.state.pages.get(tab.activePageId)?.entities.values() ?? [])].filter(e => e.drawingView);
  if (!tab.doc.state.settings.drawing && !views.length) return null;
  return <section className="pf-layout-panel-section" aria-label="Scale drawings">
    <h3>{tab.doc.state.settings.drawing ? 'Full-size drawing' : 'Drawing views'}</h3>
    {tab.doc.state.settings.drawing ? <>
      <p>Geometry 1:1 · Annotation reference 1:50</p>
      <button type="button" onClick={() => setDialog('layout')}>Add to layout…</button>
      <button type="button" onClick={() => setDialog('model')}>Insert into model…</button>
    </> : views.map(e => <div key={e.id}>
      <p>{e.drawingView!.sourceName} · 1:{e.drawingView!.denominator}</p>
      <button type="button" onClick={() => setDialog(e.id)}>Update / placement…</button>
      <button type="button" onClick={() => { try { tab.commands.execute('layout.drawing.detach', { pageId: tab.activePageId, entityId: e.id }); setError(''); } catch (e) { setError(String(e)); } }}>Detach</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
    {dialog !== null && <DrawingPlacementDialog tab={tab} session={session} mode={dialog} onClose={() => setDialog(null)} />}
  </section>;
}

function DrawingPlacementDialog({ tab, session, mode, onClose }: { tab: LayoutTab; session: DocumentSession; mode: 'layout' | 'model' | number; onClose: () => void }): JSX.Element {
  const modal = useRef<HTMLDialogElement>(null);
  useEffect(() => { modal.current?.showModal(); }, []);
  const previous = typeof mode === 'number' ? tab.doc.state.pages.get(tab.activePageId)?.entities.get(mode)?.drawingView : undefined;
  const source = previous ? session.tabs.find((t): t is LayoutTab => t.type === 'layout' && t.doc.state.meta.guid === previous.sourceGuid) : tab;
  const model = mode === 'model';
  const destinations = session.tabs.filter(t => model ? t.type === 'model' : t.type === 'layout' && !t.doc.state.settings.drawing);
  const [targetId, setTargetId] = useState(previous ? tab.id : destinations[0]?.id ?? '');
  const target = session.tabs.find(t => t.id === targetId);
  const [pageId, setPageId] = useState(previous ? tab.activePageId : target?.type === 'layout' ? target.activePageId : 0);
  const [denominator, setDenominator] = useState(String(previous?.denominator ?? 50));
  const [x, setX] = useState(String(previous?.x ?? (model ? 0 : 20))), [y, setY] = useState(String(previous?.y ?? (model ? 0 : 20)));
  const [z, setZ] = useState('0'), [rotation, setRotation] = useState(String(previous?.rotation ?? 0));
  const [plane, setPlane] = useState<DrawingPlane>('xy');
  const [error, setError] = useState('');
  const sourcePageId = previous?.sourcePageId ?? tab.activePageId;
  const submit = () => {
    try {
      if (!source || !source.doc.state.settings.drawing) throw new Error('Open the source drawing to update this view. Its saved appearance remains available.');
      if (!target) throw new Error('Open a destination document first.');
      const numbers = [x, y, z, rotation, denominator];
      if (numbers.some(n => !n.trim() || !Number.isFinite(Number(n))) || Number(denominator) <= 0) throw new Error('Enter finite coordinates and a positive scale.');
      const entities = visibleDrawingEntities(source.doc.state, sourcePageId);
      if (model && target.type === 'model') {
        const paths = drawingSketchPaths(entities, plane, [Number(x) / 1000, Number(y) / 1000, Number(z) / 1000], Number(rotation));
        if (!paths.length) throw new Error('The drawing has no visible path geometry.');
        target.app.commands.execute('sketch.insertDrawing', { paths });
      } else if (!model && target.type === 'layout') {
        if (!entities.length) throw new Error('The drawing is empty.');
        target.commands.execute('layout.drawing.place', { pageId, sourceGuid: source.doc.state.meta.guid, sourceName: source.name,
          sourcePageId, denominator: Number(denominator), x: Number(x), y: Number(y), rotation: Number(rotation), entities,
          ...(typeof mode === 'number' ? { replaceId: mode } : {}) });
      } else throw new Error('Choose a matching destination.');
      onClose(); session.activate(target.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  let entities: LayoutEntity[] = [];
  if (source) { try { entities = visibleDrawingEntities(source.doc.state, sourcePageId); } catch { /* Missing page is reported on submit. */ } }
  const coordinates = entities.filter(e => e.kind === 'path').flatMap(e => e.points);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coordinates) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const width = coordinates.length ? maxX - minX : 0, height = coordinates.length ? maxY - minY : 0;
  return <dialog ref={modal} onCancel={onClose} aria-label={model ? 'Insert drawing into model' : 'Place drawing on layout'} className="pf-drawing-dialog">
    <form onSubmit={e => { e.preventDefault(); submit(); }} >
      <h2>{model ? 'Insert drawing into model' : 'Place drawing on layout'}</h2>
      <label>Destination <select value={targetId} disabled={!!previous} onChange={e => { setTargetId(e.target.value); const t = session.tabs.find(t => t.id === e.target.value); if (t?.type === 'layout') setPageId(t.activePageId); }}>
        <option value="">Choose an open document</option>{destinations.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select></label>
      {!destinations.length && <p>Create or open a {model ? 'Model' : 'Layout'} tab, then return to this drawing.</p>}
      {!model && target?.type === 'layout' && <label>Page <select value={pageId} disabled={!!previous} onChange={e => setPageId(Number(e.target.value))}>{target.doc.state.pageOrder.map(id => <option key={id} value={id}>{target.doc.state.pages.get(id)?.name}</option>)}</select></label>}
      {model ? <label>Plane <select value={plane} onChange={e => setPlane(e.target.value as DrawingPlane)}><option value="xy">Ground · XY</option><option value="xz">Front · XZ</option><option value="yz">Side · YZ</option></select></label> : <label>Scale 1:<input aria-label="Scale denominator" type="number" min="0.000001" step="any" required value={denominator} onChange={e => setDenominator(e.target.value)} /></label>}
      <p>{width.toFixed(1)} × {height.toFixed(1)} mm full size{!model && Number(denominator) > 0 ? ` · ${(width / Number(denominator)).toFixed(1)} × ${(height / Number(denominator)).toFixed(1)} mm on paper` : ''}</p>
      <label>Origin X (mm) <input type="number" step="any" required value={x} onChange={e => setX(e.target.value)} /></label>
      <label>Origin Y (mm) <input type="number" step="any" required value={y} onChange={e => setY(e.target.value)} /></label>
      {model && <label>Origin Z (mm) <input type="number" step="any" required value={z} onChange={e => setZ(e.target.value)} /></label>}
      <label>Rotation (degrees) <input type="number" step="any" required value={rotation} onChange={e => setRotation(e.target.value)} /></label>
      <p>{model ? 'Insert an independent sketch in the model’s current editing context. Curves become segments. Text, dimensions and images are excluded.' : 'Place a locked vector group. Update explicitly from the open source drawing, or detach to edit individual objects.'}</p>
      {!source && <p role="alert">Open the source drawing to update this view.</p>}
      {error && <p role="alert">{error}</p>}
      <div><button type="button" onClick={onClose}>Cancel</button> <button type="submit" disabled={!source || !target}>{model ? 'Insert sketch' : previous ? 'Update view' : 'Place view'}</button></div>
    </form>
  </dialog>;
}
