// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect } from 'react';
import type { JSX } from 'react';
import type { DisplayKey, FaceStyle } from '@pushform/commands';
import { useApp } from '../AppContext';
import { installUiServices } from '../engine/uiServices';
import { useAppStore } from '../store';

const TOGGLES: readonly (readonly [Exclude<DisplayKey, 'faceStyle'>, string])[] = [
  ['hiddenGeometry', 'Hidden Geometry'],
  ['edges', 'Edges'],
  ['profiles', 'Profiles'],
  ['guides', 'Guides'],
  ['axes', 'Axes'],
  ['backEdges', 'Back Edges (K)'],
  ['xray', 'X-ray (I)'],
];

const FACE_STYLE_LABELS: readonly (readonly [FaceStyle, string])[] = [
  ['shaded', 'Shaded'],
  ['shadedTextures', 'Shaded with Textures'],
  ['wireframe', 'Wireframe'],
  ['hiddenLine', 'Hidden Line'],
  ['monochrome', 'Monochrome'],
];

/** Display: edge/face toggles routed through `view.set` into `store.display`. */
export function DisplayPanel(): JSX.Element {
  const app = useApp();
  const display = useAppStore((s) => s.display);
  const navigationCube = useAppStore((s) => s.navigationCube);
  useEffect(() => installUiServices(app.commands), [app]);
  const set = (key: DisplayKey, value: boolean | FaceStyle): void => {
    app.commands.tryExecute('view.set', { key, value });
  };
  return (
    <div className="pf-form">
      <div className="pf-form-section">Display</div>
      {TOGGLES.map(([key, label]) => (
        <label key={key} className="pf-form-check">
          <input type="checkbox" checked={display[key]} onChange={(e) => set(key, e.target.checked)} />
          {label}
        </label>
      ))}
      <label className="pf-form-check">
        <input type="checkbox" checked={navigationCube} onChange={(e) => app.commands.tryExecute('view.navigationCube', { value: e.target.checked })} />
        Navigation Cube
      </label>
      <div className="pf-form-section">Face Style</div>
      <div role="radiogroup" aria-label="Face style" className="pf-form">
        {FACE_STYLE_LABELS.map(([style, label]) => (
          <label key={style} className="pf-form-check">
            <input
              type="radio"
              name="pf-face-style"
              value={style}
              checked={display.faceStyle === style}
              onChange={() => app.commands.tryExecute('view.faceStyle', { style })}
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}
