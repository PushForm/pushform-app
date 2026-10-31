// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState } from 'react';
import { commonsFileUrl, type CatalogModel } from '@pushform/cloud';
import { DEFAULT_PREVIEW_VIEW, parsePreviewMesh, projectPreview, type PreviewMesh } from '@pushform/cloud/preview';

const geometryFile = (model: CatalogModel) => model.files.find(file => /\.stl$/i.test(file.name));
export function CommonsThumbnail({ model, filesUrl }: { model: CatalogModel; filesUrl: string | undefined }) {
  const generated = geometryFile(model);
  const sources = [...new Set([model.previewImage ? commonsFileUrl(filesUrl, 'images', model.previewImage.id) : null,
    model.imageUrl, generated ? commonsFileUrl(filesUrl, 'thumbnails', generated.id) : null].filter((url): url is string => !!url))];
  const [failed, setFailed] = useState<string[]>([]);
  const src = sources.find(url => !failed.includes(url));
  return src ? <img src={src} alt={model.title} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(values => [...values, src])}/>
    : <div className="missing-image"><span aria-hidden="true">◇</span><span>Preview unavailable</span></div>;
}

export function CommonsModelPreview({ model, filesUrl }: { model: CatalogModel; filesUrl: string | undefined }) {
  const [active, setActive] = useState(false);
  const file = geometryFile(model);
  const url = file ? commonsFileUrl(filesUrl, 'previews', file.id) : null;
  return <section className="model-preview" aria-label="Model preview">
    {active && url ? <InteractivePreview url={url} model={model}/> : <CommonsThumbnail model={model} filesUrl={filesUrl}/>}
    <div className="preview-actions">{url ? <button onClick={() => setActive(value => !value)}>{active ? 'Show thumbnail' : 'Explore in 3D'}</button> : <p>3D preview is currently available for STL models.</p>}</div>
  </section>;
}

function InteractivePreview({ url, model }: { url: string; model: CatalogModel }) {
  const [mesh, setMesh] = useState<PreviewMesh | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [view, setView] = useState({ ...DEFAULT_PREVIEW_VIEW });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const abort = new AbortController(); setMesh(null); setError('');
    void (async () => {
      const response = await fetch(url, { signal: abort.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(response.status === 422 ? 'This model cannot be previewed yet. Try Open in PushForm.' : 'The model preview is unavailable.');
      if (response.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw new Error('The preview response is invalid.');
      if (!response.body) throw new Error('The model preview is empty.');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('The preview exceeds its display limit.'); } chunks.push(next.value);
      } } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const result = JSON.parse(new TextDecoder().decode(bytes)) as { modelId?: unknown; revision?: unknown; mesh?: unknown };
      if (result.modelId !== model.id || result.revision !== model.revision) throw new Error('The model revision changed. Refresh its page.');
      if (!abort.signal.aborted) setMesh(parsePreviewMesh(result.mesh));
    })().catch(failure => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : 'The model preview is unavailable.'); });
    return () => abort.abort();
  }, [url, model.id, model.revision, attempt]);
  const zoom = (factor: number) => setView(current => ({ ...current, zoom: Math.max(.4, Math.min(2.5, current.zoom * factor)) }));
  const orbit = (yaw: number, pitch = 0) => setView(current => ({ ...current, yaw: current.yaw + yaw, pitch: Math.max(-1.4, Math.min(1.4, current.pitch + pitch)) }));
  if (error) return <div className="preview-error"><CommonsThumbnail model={model} filesUrl={new URL(url).origin}/><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div>;
  if (!mesh) return <div className="preview-loading" role="status">Rendering model preview…</div>;
  return <>
    <svg className="preview-viewer" viewBox="0 0 480 400" tabIndex={0} role="img" aria-label={`Interactive 3D preview of ${model.title}. Use arrow keys to rotate, plus or minus to zoom, and zero to reset.`}
      onPointerDown={event => { if(event.button!==0)return; drag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { const previous = drag.current; if (previous) { orbit((event.clientX - previous.x) / 120, (event.clientY - previous.y) / 120); drag.current = { x: event.clientX, y: event.clientY }; } }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={event => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(event.key)) event.preventDefault();
        if (event.key === 'ArrowLeft') orbit(-.2); if (event.key === 'ArrowRight') orbit(.2); if (event.key === 'ArrowUp') orbit(0, -.2); if (event.key === 'ArrowDown') orbit(0, .2);
        if (event.key === '+' || event.key === '=') zoom(1.2); if (event.key === '-') zoom(1 / 1.2); if (event.key === '0') setView({ ...DEFAULT_PREVIEW_VIEW }); }}>
      <rect width="480" height="400" fill="#eef0e8"/>
      {projectPreview(mesh, view).map((face, i) => <polygon key={i} points={face.points} fill={face.fill} stroke="#40584e" strokeWidth=".5" strokeLinejoin="round"/>)}
    </svg>
    <div className="preview-controls" aria-label="3D preview controls">
      <button aria-label="Rotate left" title="Rotate left" onClick={() => orbit(-.3)}><RotateIcon/></button><button aria-label="Rotate right" title="Rotate right" onClick={() => orbit(.3)}><RotateIcon clockwise/></button>
      <button aria-label="Tilt up" onClick={() => orbit(0, -.2)}>↑</button><button aria-label="Tilt down" onClick={() => orbit(0, .2)}>↓</button>
      <button aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}>−</button><button aria-label="Zoom in" onClick={() => zoom(1.2)}>+</button>
      <button onClick={() => setView({ ...DEFAULT_PREVIEW_VIEW })}>Reset view</button>
    </div><p className="preview-caption">Drag to rotate · use controls to zoom. Geometry preview; units and dimensions are not shown.</p>
  </>;
}

function RotateIcon({ clockwise = false }: { clockwise?: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <g transform={clockwise ? 'translate(24 0) scale(-1 1)' : undefined}><path d="M3 10a9 9 0 1 1 2.7 8.4"/><path d="M3 4v6h6"/></g>
  </svg>;
}
