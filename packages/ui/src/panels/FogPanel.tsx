// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect } from 'react';
import type { JSX } from 'react';
import { fogOf } from '@pushform/commands';
import { DEFAULT_FOG } from '@pushform/model';
import type { FogPatch } from '@pushform/commands';
import { useApp } from '../AppContext';
import { installUiServices } from '../engine/uiServices';
import { useDocumentState } from '../hooks/useDocument';
import { cssToRgb, rgbToCss } from './colors';

/** Slider range: a bit beyond the scene so the far handle can clear it. */
function fogRange(app: ReturnType<typeof useApp>, far: number): number {
  const b = app.viewport.sceneBounds();
  const size = b ? Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : 0;
  return Math.max(50, Math.ceil(Math.max(size * 4, far * 1.25) / 10) * 10);
}

/**
 * Near and far distances for fog that has just been switched on: the near distance halfway to the
 * model and the far distance three times as far, so the model is lightly misted and what lies
 * behind it fades out. Whole meters, never less than 10 m for far. `null` when the view has no
 * model to measure against.
 */
export function fogDistancesFor(eye: readonly number[], bounds: { min: readonly number[]; max: readonly number[] } | null): { near: number; far: number } | null {
  if (!bounds) return null;
  const c = [0, 1, 2].map((i) => (bounds.min[i]! + bounds.max[i]!) / 2);
  const dist = Math.hypot(eye[0]! - c[0]!, eye[1]! - c[1]!, eye[2]! - c[2]!);
  if (!(dist > 0)) return null;
  return { near: Math.round(dist * 0.5), far: Math.max(10, Math.round(dist * 3)) };
}

/** Fog panel: Display Fog, near/far distance handles, background or custom color. */
export function FogPanel(): JSX.Element {
  const app = useApp();
  const state = useDocumentState();
  useEffect(() => installUiServices(app.commands), [app]);
  const fog = fogOf(state);
  const set = (patch: FogPatch) => app.commands.tryExecute('fog.set', { patch });
  const max = fogRange(app, fog.far);
  // Fog still at its stock distances (100 m would barely show on a model a few meters across) takes
  // distances measured from the view when it is switched on; distances the user set are kept.
  const enableFog = (enabled: boolean): FogPatch => {
    if (!enabled || fog.near !== DEFAULT_FOG.near || fog.far !== DEFAULT_FOG.far) return { enabled };
    return { enabled, ...fogDistancesFor(app.viewport.camera.getState().eye, app.viewport.sceneBounds()) };
  };
  return (
    <div className="pf-form pf-fog">
      <label className="pf-form-check">
        <input type="checkbox" checked={fog.enabled} onChange={(e) => set(enableFog(e.target.checked))} />
        Display Fog
      </label>
      <div className="pf-form-section">Distance</div>
      <div className="pf-form-row">
        <span className="pf-form-label">Near</span>
        <div className="pf-form-range">
          <input type="range" aria-label="Fog near" min={0} max={max} step={1} value={fog.near} onChange={(e) => set({ near: Number(e.target.value) })} />
          <span>{fog.near} m</span>
        </div>
      </div>
      <div className="pf-form-row">
        <span className="pf-form-label">Far</span>
        <div className="pf-form-range">
          <input type="range" aria-label="Fog far" min={0} max={max} step={1} value={fog.far} onChange={(e) => set({ far: Number(e.target.value) })} />
          <span>{fog.far} m</span>
        </div>
      </div>
      <div className="pf-form-section">Color</div>
      <label className="pf-form-check">
        <input type="checkbox" checked={fog.useBackground} onChange={(e) => set({ useBackground: e.target.checked })} />
        Use background color
      </label>
      <div className="pf-form-row">
        <span className="pf-form-label">Fog color</span>
        <input
          type="color"
          className="pf-tag-color"
          aria-label="Fog color"
          disabled={fog.useBackground}
          value={rgbToCss(fog.color)}
          onChange={(e) => set({ color: cssToRgb(e.target.value) })}
        />
      </div>
    </div>
  );
}
