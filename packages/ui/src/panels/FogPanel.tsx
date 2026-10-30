// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect } from 'react';
import type { JSX } from 'react';
import { fogOf } from '@pushform/commands';
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

/** Fog panel: Display Fog, near/far distance handles, background or custom color. */
export function FogPanel(): JSX.Element {
  const app = useApp();
  const state = useDocumentState();
  useEffect(() => installUiServices(app.commands), [app]);
  const fog = fogOf(state);
  const set = (patch: FogPatch) => app.commands.tryExecute('fog.set', { patch });
  const max = fogRange(app, fog.far);
  return (
    <div className="pf-form pf-fog">
      <label className="pf-form-check">
        <input type="checkbox" checked={fog.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
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
