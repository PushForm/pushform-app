// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { STYLE_PRESETS, presetStyle } from '@pushform/commands';
import type { StylePatch } from '@pushform/commands';
import type { FaceStyleMode, Style } from '@pushform/model';
import { useApp } from '../AppContext';
import { installUiServices } from '../engine/uiServices';
import { useDocumentState } from '../hooks/useDocument';
import { cssToRgb, rgbToCss } from './colors';

type Tab = 'select' | 'edit';
type Pane = 'edge' | 'face' | 'background' | 'modeling';

const FACE_MODES: readonly (readonly [FaceStyleMode, string])[] = [
  ['wireframe', 'Wireframe'],
  ['hiddenLine', 'Hidden Line'],
  ['shaded', 'Shaded'],
  ['shadedWithTextures', 'Textured'],
  ['monochrome', 'Monochrome'],
  ['xray', 'X-ray'],
];

/** Two-color chip standing in for a style thumbnail: background over the front face color. */
function StyleChip({ style, active, onClick, label }: { style: Pick<Style, 'background' | 'faces' | 'edges'>; active: boolean; onClick: () => void; label: string }): JSX.Element {
  const bg = style.background.sky ? style.background.skyColor : style.background.color;
  return (
    <button type="button" className={`pf-style-chip${active ? ' is-active' : ''}`} aria-pressed={active} aria-label={label} title={label} onClick={onClick}>
      <span className="pf-style-chip-swatch" style={{ background: rgbToCss(bg) }}>
        <span className="pf-style-chip-face" style={{ background: rgbToCss(style.faces.frontColor), borderColor: rgbToCss(style.edges.color) }} />
      </span>
      <span className="pf-style-chip-name">{label}</span>
    </button>
  );
}

function ColorRow({ label, value, onChange, disabled, note }: { label: string; value: readonly [number, number, number]; onChange: (rgb: [number, number, number]) => void; disabled?: boolean; note?: string | undefined }): JSX.Element {
  return (
    <div className="pf-form-row" title={note}>
      <span className="pf-form-label">{label}</span>
      <input type="color" className="pf-tag-color" aria-label={label} value={rgbToCss(value)} disabled={disabled} onChange={(e) => onChange(cssToRgb(e.target.value))} />
    </div>
  );
}

/** Note on controls the viewport does not draw yet. */
const NOT_DRAWN = 'Not drawn yet';

function NumberRow({ label, value, min, max, step = 1, onChange, disabled }: { label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; onChange: (v: number) => void }): JSX.Element {
  return (
    <div className="pf-form-row">
      <span className="pf-form-label">{label}</span>
      <input
        type="number"
        className="pf-form-input"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
      />
    </div>
  );
}

function Check({ label, checked, onChange, disabled, note }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; note?: string | undefined }): JSX.Element {
  return (
    <label className="pf-form-check" title={note}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/**
 * Styles panel: Select tab (In Model styles + built-in presets as colored chips,
 * Create / Delete / Reset) and Edit tab with the Edge, Face, Background and Modeling panes.
 * Every edit goes through `style.update` on the active style, which drives the viewport.
 */
export function StylesPanel(): JSX.Element {
  const app = useApp();
  const state = useDocumentState();
  useEffect(() => installUiServices(app.commands), [app]);
  const [tab, setTab] = useState<Tab>('select');
  const [pane, setPane] = useState<Pane>('edge');
  const style = state.styles.get(state.activeStyleId);
  const run = (id: string, params?: unknown) => app.commands.tryExecute(id, params);
  const patch = (p: StylePatch) => run('style.update', { patch: p });
  if (!style) return <div className="pf-form-note">No active style.</div>;
  const inModel = [...state.styles.values()];
  const presets = STYLE_PRESETS.map((p) => ({ name: p.name, style: presetStyle(p.name, 0 as never) }));

  return (
    <div className="pf-form pf-styles">
      <div className="pf-tabs" role="tablist">
        <button type="button" role="tab" className={`pf-tab${tab === 'select' ? ' is-active' : ''}`} aria-selected={tab === 'select'} onClick={() => setTab('select')}>
          Select
        </button>
        <button type="button" role="tab" className={`pf-tab${tab === 'edit' ? ' is-active' : ''}`} aria-selected={tab === 'edit'} onClick={() => setTab('edit')}>
          Edit
        </button>
      </div>
      <div className="pf-form-row">
        <span className="pf-form-label">Style</span>
        <input className="pf-form-input" aria-label="Style name" value={style.name} onChange={(e) => patch({ name: e.target.value })} />
      </div>
      {tab === 'select' ? (
        <>
          <div className="pf-form-section">In Model</div>
          <div className="pf-style-grid" role="listbox" aria-label="Styles in model">
            {inModel.map((s) => (
              <StyleChip key={s.id} style={s} label={s.name} active={s.id === state.activeStyleId} onClick={() => run('style.setActive', { id: s.id })} />
            ))}
          </div>
          <div className="pf-form-section">Presets</div>
          <div className="pf-style-grid" role="listbox" aria-label="Style presets">
            {presets.map((p) => (
              <StyleChip key={p.name} style={p.style} label={p.name} active={false} onClick={() => run('style.usePreset', { name: p.name })} />
            ))}
          </div>
          <div className="pf-form-actions">
            <button type="button" className="pf-btn" onClick={() => run('style.create', {})}>
              Create
            </button>
            <button type="button" className="pf-btn" disabled={inModel.length <= 1} onClick={() => run('style.delete', { id: style.id })}>
              Delete
            </button>
            <button type="button" className="pf-btn" onClick={() => run('style.resetToDefault', {})}>
              Reset
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="pf-tabs pf-tabs-sub" role="tablist" aria-label="Style panes">
            {(
              [
                ['edge', 'Edge'],
                ['face', 'Face'],
                ['background', 'Background'],
                ['modeling', 'Modeling'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="tab" className={`pf-tab${pane === id ? ' is-active' : ''}`} aria-selected={pane === id} onClick={() => setPane(id)}>
                {label}
              </button>
            ))}
          </div>
          {pane === 'edge' ? (
            <>
              <Check label="Edges" checked={style.edges.edges} onChange={(v) => patch({ edges: { edges: v } })} />
              <Check label="Back Edges" checked={style.edges.backEdges} onChange={(v) => patch({ edges: { backEdges: v } })} />
              <Check label="Profiles" checked={style.edges.profiles} onChange={(v) => patch({ edges: { profiles: v } })} />
              <NumberRow label="Profiles px" value={style.edges.profileWidth} min={1} max={10} disabled={!style.edges.profiles} onChange={(v) => patch({ edges: { profileWidth: v } })} />
              <Check label="Depth cue" checked={style.edges.depthCue} onChange={(v) => patch({ edges: { depthCue: v } })} />
              <NumberRow label="Depth cue px" value={style.edges.depthCueLevels} min={1} max={10} disabled={!style.edges.depthCue} onChange={(v) => patch({ edges: { depthCueLevels: v } })} />
              <Check label="Extension" checked={style.edges.extension} onChange={(v) => patch({ edges: { extension: v } })} />
              <NumberRow label="Extension px" value={style.edges.extensionLength} min={1} max={20} disabled={!style.edges.extension} onChange={(v) => patch({ edges: { extensionLength: v } })} />
              <Check label="Endpoints" checked={style.edges.endpoints} disabled note={NOT_DRAWN} onChange={(v) => patch({ edges: { endpoints: v } })} />
              <NumberRow label="Endpoints px" value={style.edges.endpointLength} min={1} max={20} disabled onChange={(v) => patch({ edges: { endpointLength: v } })} />
              <Check label="Jitter" checked={style.edges.jitter} disabled note={NOT_DRAWN} onChange={(v) => patch({ edges: { jitter: v } })} />
              <p className="pf-options-hint">Endpoints and Jitter are not drawn yet.</p>
              <div className="pf-form-row">
                <span className="pf-form-label">Color</span>
                <select
                  className="pf-form-select"
                  aria-label="Edge color mode"
                  value={style.edges.colorMode}
                  onChange={(e) => patch({ edges: { colorMode: e.target.value as Style['edges']['colorMode'] } })}
                >
                  <option value="allSame">All same</option>
                  <option value="byMaterial" disabled title="Edges have no material of their own">By material</option>
                  <option value="byAxis">By axis</option>
                </select>
              </div>
              <ColorRow label="Edge color" value={style.edges.color} onChange={(rgb) => patch({ edges: { color: rgb } })} />
            </>
          ) : null}
          {pane === 'face' ? (
            <>
              <ColorRow label="Front color" value={style.faces.frontColor} onChange={(rgb) => patch({ faces: { frontColor: rgb } })} />
              <ColorRow label="Back color" value={style.faces.backColor} onChange={(rgb) => patch({ faces: { backColor: rgb } })} />
              <div className="pf-form-section">Style</div>
              <div className="pf-style-modes" role="radiogroup" aria-label="Face style">
                {FACE_MODES.map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={style.faces.mode === mode}
                    className={`pf-btn${style.faces.mode === mode ? ' is-active' : ''}`}
                    onClick={() => patch({ faces: { mode } })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <NumberRow label="X-ray opacity" value={style.faces.xrayOpacity} min={0.05} max={1} step={0.05} onChange={(v) => patch({ faces: { xrayOpacity: v } })} />
              <div className="pf-form-row">
                <span className="pf-form-label">Transparency</span>
                <select
                  className="pf-form-select"
                  aria-label="Transparency quality"
                  value={style.faces.transparencyQuality ?? 'medium'}
                  onChange={(e) => patch({ faces: { transparencyQuality: e.target.value as 'faster' | 'medium' | 'nicer' } })}
                >
                  <option value="faster">Faster</option>
                  <option value="medium">Medium</option>
                  <option value="nicer">Nicer</option>
                </select>
              </div>
            </>
          ) : null}
          {pane === 'background' ? (
            <>
              <ColorRow label="Background" value={style.background.color} onChange={(rgb) => patch({ background: { color: rgb } })} />
              <Check label="Sky" checked={style.background.sky} onChange={(v) => patch({ background: { sky: v } })} />
              <ColorRow label="Sky color" value={style.background.skyColor} onChange={(rgb) => patch({ background: { skyColor: rgb } })} />
              <Check label="Ground" checked={style.background.ground} onChange={(v) => patch({ background: { ground: v } })} />
              <ColorRow label="Ground color" value={style.background.groundColor} onChange={(rgb) => patch({ background: { groundColor: rgb } })} />
              <div className="pf-form-row">
                <span className="pf-form-label">Transparency</span>
                <div className="pf-form-range">
                  <input
                    type="range"
                    aria-label="Ground transparency"
                    min={0}
                    max={1}
                    step={0.05}
                    value={style.background.groundTransparency}
                    onChange={(e) => patch({ background: { groundTransparency: Number(e.target.value) } })}
                  />
                  <span>{Math.round(style.background.groundTransparency * 100)}%</span>
                </div>
              </div>
              <Check label="Show ground from below" checked={style.background.showGroundFromBelow} onChange={(v) => patch({ background: { showGroundFromBelow: v } })} />
            </>
          ) : null}
          {pane === 'modeling' ? (
            <>
              <ColorRow label="Selected" value={style.modeling.selected} onChange={(rgb) => patch({ modeling: { selected: rgb } })} />
              <ColorRow label="Locked" value={style.modeling.locked} disabled note={NOT_DRAWN} onChange={(rgb) => patch({ modeling: { locked: rgb } })} />
              <ColorRow label="Guides" value={style.modeling.guides} onChange={(rgb) => patch({ modeling: { guides: rgb } })} />
              <ColorRow label="Inactive section" value={style.modeling.inactiveSection} onChange={(rgb) => patch({ modeling: { inactiveSection: rgb } })} />
              <ColorRow label="Active section" value={style.modeling.activeSection} onChange={(rgb) => patch({ modeling: { activeSection: rgb } })} />
              <ColorRow label="Section fill" value={style.modeling.sectionFill} onChange={(rgb) => patch({ modeling: { sectionFill: rgb } })} />
              <ColorRow label="Section line" value={style.modeling.sectionLine} onChange={(rgb) => patch({ modeling: { sectionLine: rgb } })} />
              <NumberRow label="Section line px" value={style.modeling.sectionLineWidth} min={1} max={10} onChange={(v) => patch({ modeling: { sectionLineWidth: v } })} />
              <Check label="Hidden Geometry" checked={style.modeling.hiddenGeometry} onChange={(v) => patch({ modeling: { hiddenGeometry: v } })} />
              <Check label="Color by Tag" checked={style.modeling.colorByTag === true} onChange={(v) => patch({ modeling: { colorByTag: v } })} />
              <Check label="Guides" checked={style.modeling.guidesVisible} onChange={(v) => patch({ modeling: { guidesVisible: v } })} />
              <Check label="Section Planes" checked={style.modeling.sectionPlanesVisible} onChange={(v) => patch({ modeling: { sectionPlanesVisible: v } })} />
              <Check label="Section Cuts" checked={style.modeling.sectionCutsVisible} onChange={(v) => patch({ modeling: { sectionCutsVisible: v } })} />
              <Check label="Section Fill" checked={style.modeling.sectionFillEnabled} onChange={(v) => patch({ modeling: { sectionFillEnabled: v } })} />
              <Check label="Model Axes" checked={style.modeling.modelAxesVisible} onChange={(v) => patch({ modeling: { modelAxesVisible: v } })} />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
