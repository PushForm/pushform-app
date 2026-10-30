// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState, type JSX } from 'react';
import { isViewport, LAYOUT_DIMENSION_SCALES, layoutDimensionScaleLabel, viewportCloudReference, viewportSourceKey, type LayoutDocumentState, type LayoutEntity, type LayoutViewportCamera } from '@pushform/layout';
import type { StandardView } from '@pushform/render';
import { layoutViewportFailure, layoutViewportModel, layoutViewportStatus, type LayoutViewportModel } from './layoutViewportRenders';
import { projectionViewportCamera, sceneViewportCamera, standardViewportCamera } from './layoutViewportCameras';

const VIEWS: { id: StandardView; label: string }[] = [
  { id: 'top', label: 'Top' }, { id: 'front', label: 'Front' }, { id: 'right', label: 'Right' },
  { id: 'back', label: 'Back' }, { id: 'left', label: 'Left' }, { id: 'bottom', label: 'Bottom' }, { id: 'iso', label: 'Iso' },
];

const STATUS: Record<ReturnType<typeof layoutViewportStatus>, string> = {
  cached: 'Showing the render saved with the LayOut document.',
  current: 'Rendered from the model.',
  rendering: 'Rendering…',
  unavailable: 'The model cannot be rendered.',
};

/** Selection panel controls for a model view: its scene, standard views, navigation, and render status. */
/** A cloud view's stored picture names the model revision it shows. */
function statusText(state: LayoutDocumentState, entity: LayoutEntity): string {
  const status = layoutViewportStatus(state, entity);
  const reference = isViewport(entity) ? viewportCloudReference(state, entity.image.viewport.source) : undefined;
  return status === 'cached' && reference ? `Showing the stored render of revision ${reference.target.revisionNumber}.` : STATUS[status];
}

export function LayoutViewportPanel({ entity, state, disabled, navigating, onCamera, onNavigate, onResizeMode }: {
  entity: LayoutEntity;
  state: LayoutDocumentState;
  disabled: boolean;
  navigating: boolean;
  onCamera: (camera: LayoutViewportCamera, scene: string | null) => void;
  onNavigate: (navigating: boolean) => void;
  onResizeMode: (preserve: boolean) => void;
}): JSX.Element | null {
  const viewport = isViewport(entity) ? entity.image.viewport : null;
  const sourceKey = viewport ? viewportSourceKey(state, viewport.source) : '';
  const [model, setModel] = useState<LayoutViewportModel | null>(null);
  useEffect(() => {
    if (!viewport) return undefined;
    let live = true;
    setModel(null);
    layoutViewportModel(state, viewport.source).then(loaded => { if (live) setModel(loaded); }, () => { if (live) setModel(null); });
    return () => { live = false; };
    // The model depends only on its source; later document edits do not reload it.
  }, [sourceKey]);
  if (!viewport) return null;
  const failure = layoutViewportFailure(state, viewport.source);
  const scenes = model?.scenes.filter(scene => scene.camera) ?? [];
  const sceneValue = viewport.scene !== null && scenes.some(scene => scene.name === viewport.scene) ? viewport.scene : '';
  const unavailable = disabled || !model;
  const parallel = viewport.camera.projection === 'parallel', scale = viewport.camera.scale;
  const preset = LAYOUT_DIMENSION_SCALES.findIndex(item => item.label === layoutDimensionScaleLabel(scale));
  const preserve = viewport.preserveScaleOnResize !== false;
  return (
    <section className="pf-layout-panel-section" aria-label="Model view">
      <h3>Model view</h3>
      <p className="pf-layout-panel-note" role="status">{failure ? `${STATUS.unavailable} ${failure}` : model ? statusText(state, entity) : 'Loading the model…'}</p>
      <label>Projection<select value={viewport.camera.projection} disabled={disabled}
        onChange={event => onCamera(projectionViewportCamera(viewport.camera, event.target.value as LayoutViewportCamera['projection'], entity.points), viewport.scene)}>
        <option value="parallel">Parallel</option><option value="perspective">Perspective</option>
      </select></label>
      <label>Drawing scale<select value={parallel ? preset < 0 ? 'custom' : String(preset) : 'perspective'} disabled={disabled || !parallel}
        onChange={event => {
          const choice = LAYOUT_DIMENSION_SCALES[Number(event.target.value)];
          if (choice) onCamera({ ...viewport.camera, scale: choice.scale }, viewport.scene);
        }}>
        {!parallel ? <option value="perspective">Not to scale</option> : null}
        {preset < 0 ? <option value="custom">{layoutDimensionScaleLabel(scale)}</option> : null}
        {LAYOUT_DIMENSION_SCALES.map((item, index) => <option key={index} value={index}>{item.label}</option>)}
      </select></label>
      {parallel ? <ViewportScaleInput key={`${entity.id}:${scale}`} scale={scale} disabled={disabled}
        onCommit={next => onCamera({ ...viewport.camera, scale: next }, viewport.scene)} />
        : <p className="pf-layout-panel-note">Perspective views have no uniform drawing scale.</p>}
      <label><input type="checkbox" checked={preserve} disabled={disabled}
        onChange={event => onResizeMode(event.target.checked)} /> Preserve scale on resize</label>
      <p className="pf-layout-panel-note">{preserve
        ? 'Resizing changes the visible extent; the model stays in place at the same paper size.'
        : parallel ? 'Resizing the frame height changes the drawing scale.' : 'Resizing the frame height changes the model’s paper size.'}</p>
      <label>
        Scene
        <select aria-label="Scene" value={sceneValue} disabled={unavailable || scenes.length === 0}
          onChange={(event) => {
            const scene = scenes.find(candidate => candidate.name === event.target.value);
            const camera = scene && sceneViewportCamera(scene, entity.points);
            if (scene && camera) onCamera(camera, scene.name);
          }}>
          <option value="" disabled>{viewport.scene !== null && !sceneValue ? viewport.scene : 'Custom view'}</option>
          {scenes.map(scene => <option key={scene.name} value={scene.name}>{scene.name}</option>)}
        </select>
      </label>
      <div className="pf-layout-view-buttons" role="group" aria-label="Standard views">
        {VIEWS.map(view => <button key={view.id} type="button" disabled={unavailable}
          onClick={() => onCamera(standardViewportCamera(viewport.camera, view.id, entity.points, model?.bounds ?? null), null)}>{view.label}</button>)}
      </div>
      <button type="button" aria-pressed={navigating} disabled={unavailable} onClick={() => onNavigate(!navigating)}>
        {navigating ? 'Done navigating' : 'Navigate view'}
      </button>
      <p className="pf-layout-panel-note">{navigating
        ? 'Drag to orbit, Shift+drag or middle-drag to pan, and scroll to zoom. Press Escape when done.'
        : 'Double-click the view to orbit, pan, and zoom its camera.'}</p>
    </section>
  );
}

function ViewportScaleInput({ scale, disabled, onCommit }: { scale: number; disabled: boolean; onCommit: (value: number) => void }): JSX.Element {
  const shown = String(Number((1 / scale).toPrecision(12))), [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    const ratio = Number(draft);
    if (!disabled && draft !== null && draft.trim() && ratio > 0 && Number.isFinite(ratio) && Number.isFinite(1 / ratio) && draft !== shown) onCommit(1 / ratio);
    setDraft(null);
  };
  return <label>Custom scale 1:<input aria-label="Custom drawing scale ratio" type="number" min="0" step="any" disabled={disabled}
    value={draft ?? shown} onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') setDraft(null); }} /></label>;
}
