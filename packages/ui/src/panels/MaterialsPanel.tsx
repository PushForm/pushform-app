// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, CSSProperties, JSX, KeyboardEvent, MouseEvent } from 'react';
import { BUILTIN_LIBRARY } from '@pushform/commands';
import { colorizedImageUrl } from '@pushform/render';
import type { LibraryMaterial, PaintTool } from '@pushform/commands';
import type { Material, Rgb } from '@pushform/model';
import { useApp } from '../AppContext';
import { installUiServices } from '../engine/uiServices';
import { rgbToCss } from '../engine/format';
import { useSelectionRefs } from '../hooks/useSelection';
import { useAppStore } from '../store';
import type { MaterialsTab } from '../store';

/** `#rrggbb` → [r, g, b] in 0..1. */
export function cssToRgb01(css: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** RGB (0..1) → HLS with H in degrees, L and S in percent (Materials panel "HLS" picker). */
export function rgbToHls(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, Math.round(l * 100), 0];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [Math.round(h), Math.round(l * 100), Math.round(s * 100)];
}

export function hlsToRgb(h: number, l: number, s: number): Rgb {
  const L = Math.min(1, Math.max(0, l / 100)), S = Math.min(1, Math.max(0, s / 100));
  const H = (((h % 360) + 360) % 360) / 360;
  if (S === 0) return [L, L, L];
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S;
  const p = 2 * L - q;
  const f = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(H + 1 / 3), f(H), f(H - 1 / 3)];
}

type LibraryId = 'inModel' | LibraryMaterial['category'];
const LIBRARIES: readonly (readonly [LibraryId, string])[] = [
  ['inModel', 'In Model'],
  ['Colors', 'Colors'],
  ['Wood', 'Wood'],
  ['Brick', 'Brick'],
  ['Tile', 'Tile'],
  ['Glass', 'Glass'],
  ['Metal', 'Metal'],
  ['Stone', 'Stone'],
];
type ThumbSize = 'small' | 'large' | 'list';

interface ItemMenu {
  readonly x: number;
  readonly y: number;
  readonly id: number | null;
}

/** Colorized swatch images by `url|color|type`; null while loading or when one cannot be made. */
const colorizedSwatches = new Map<string, string | null>();

/** Swatch style for a material: its color (texture image when it has one), opacity as alpha. */
function swatchStyle(m: Material | null, textureUrl: string | undefined): CSSProperties {
  if (!m) return { background: '#ffffff' };
  const base: CSSProperties = { background: rgbToCss(m.color), opacity: m.alpha };
  if (textureUrl) base.backgroundImage = `url("${textureUrl}")`;
  return base;
}

function NumberField({ label, value, onCommit, step = 1, min, max }: { label: string; value: number; onCommit: (v: number) => void; step?: number; min?: number; max?: number }): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const v = Number(draft);
    if (Number.isFinite(v) && v !== value) onCommit(v);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') setDraft(String(value));
    e.stopPropagation();
  };
  return (
    <input className="pf-form-input" type="number" aria-label={label} value={draft} step={step} min={min} max={max} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKey} />
  );
}

/**
 * Materials panel: active material header with Create and Sample, a Select tab
 * (In Model list + built-in libraries, thumbnail sizes, purge, per-item context menu) and an
 * Edit tab (color picker with RGB/HLS, opacity, texture image, size with aspect lock, colorize).
 */
export function MaterialsPanel(): JSX.Element {
  const app = useApp();
  useEffect(() => installUiServices(app.commands), [app]);
  useSelectionRefs(); // re-render on document changes (material edits, paint)
  const activeId = useAppStore((s) => s.activeMaterialId);
  const tab = useAppStore((s) => s.materialsTab);
  const setTab = useAppStore((s) => s.setMaterialsTab);
  const setActiveId = useAppStore((s) => s.setActiveMaterialId);
  const [library, setLibrary] = useState<LibraryId>('inModel');
  const [thumb, setThumb] = useState<ThumbSize>('small');
  const [menu, setMenu] = useState<ItemMenu | null>(null);
  const [lockAspect, setLockAspect] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const state = app.document.doc.state;
  const images = app.document.images;
  const inModel = useMemo(() => [...state.materials.values()].filter((m) => m.id !== state.defaultMaterialId), [state.materials, state.defaultMaterialId]);
  const active = activeId === null ? null : (state.materials.get(activeId as Material['id']) ?? null);
  const [, setSwatchVersion] = useState(0);
  /** The material's texture image, colorized as it is drawn when the material colorizes it. */
  const textureUrl = (m: Material | null): string | undefined => {
    const url = m?.texture ? images.objectUrl(m.texture.imageId) : undefined;
    if (!url || !m?.texture?.colorize) return url;
    const color = rgbToCss(m.color), type = m.texture.colorizeType ?? 'shift', key = `${url}|${color}|${type}`;
    if (!colorizedSwatches.has(key)) {
      colorizedSwatches.set(key, null);
      void colorizedImageUrl(url, color, type).then((made) => { colorizedSwatches.set(key, made); setSwatchVersion((v) => v + 1); });
    }
    return colorizedSwatches.get(key) ?? url;
  };

  const run = (id: string, params?: unknown): unknown => {
    const r = app.commands.tryExecute(id, params);
    if (!r.ok) {
      setError(r.error instanceof Error ? r.error.message : String(r.error));
      return undefined;
    }
    setError(null);
    return r.result;
  };

  const create = () => {
    run('material.create', { name: 'Material', color: [0.8, 0.8, 0.8] });
    setTab('edit');
  };
  const sample = () => {
    try {
      app.toolManager.activate('paint');
      const tool = app.toolManager.activeTool as (PaintTool & { setSampling?: (on: boolean) => void }) | null;
      tool?.setSampling?.(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const update = (patch: Record<string, unknown>) => {
    if (!active) return;
    run('material.update', { id: active.id, ...patch });
  };
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !active) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const res = (await app.commands.execute('material.importImage', { bytes, name: file.name, mime: file.type || 'image/png', createMaterial: false, activate: false })) as {
        imageId: number;
        width: number;
        height: number;
      };
      const aspect = res.width > 0 && res.height > 0 ? res.height / res.width : 1;
      const widthM = active.texture?.widthM ?? 1;
      run('material.update', { id: active.id, texture: { imageId: res.imageId, widthM, heightM: widthM * aspect } });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    e.target.value = '';
  };
  const onItemContextMenu = (e: MouseEvent, id: number | null) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, id });
  };
  const menuAction = (action: 'delete' | 'select' | 'edit' | 'duplicate') => {
    const id = menu?.id ?? null;
    setMenu(null);
    if (id === null) return;
    switch (action) {
      case 'delete':
        run('material.delete', { id });
        break;
      case 'select':
        run('material.selectFaces', { id });
        break;
      case 'edit':
        setActiveId(id);
        setTab('edit');
        break;
      case 'duplicate':
        run('material.duplicate', { id });
        break;
    }
  };

  const libraryItems: LibraryMaterial[] = library === 'inModel' ? [] : BUILTIN_LIBRARY.filter((m) => m.category === library);
  const gridClass = `pf-materials-grid${thumb === 'large' ? ' is-large' : thumb === 'list' ? ' is-list' : ''}`;

  return (
    <div className="pf-materials" onClick={() => menu && setMenu(null)}>
      <div className="pf-materials-head">
        <div className="pf-materials-active" aria-label="Active material">
          <span className="pf-swatch" style={swatchStyle(active, textureUrl(active))} aria-hidden="true" />
          <span className="pf-materials-name">{active ? active.name : 'Default'}</span>
        </div>
        <button type="button" className="pf-btn" onClick={create}>
          Create
        </button>
        <button type="button" className="pf-btn" onClick={sample} title="Sample a material from the model (Paint Bucket + Alt)">
          Sample
        </button>
      </div>
      <div className="pf-materials-tabs" role="tablist">
        {(['select', 'edit'] as MaterialsTab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`pf-materials-tab${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
            {t === 'select' ? 'Select' : 'Edit'}
          </button>
        ))}
      </div>
      {error ? <p className="pf-form-note pf-dialog-error">{error}</p> : null}
      {tab === 'select' ? (
        <>
          <div className="pf-materials-toolbar">
            <select className="pf-form-select" aria-label="Library" value={library} onChange={(e) => setLibrary(e.target.value as LibraryId)}>
              {LIBRARIES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="pf-btn"
              aria-label="Thumbnail size"
              title="Thumbnail size"
              onClick={() => setThumb(thumb === 'small' ? 'large' : thumb === 'large' ? 'list' : 'small')}
            >
              {thumb === 'small' ? 'S' : thumb === 'large' ? 'L' : '≡'}
            </button>
            {library === 'inModel' ? (
              <button type="button" className="pf-btn" onClick={() => run('material.purgeUnused')} title="Purge unused materials">
                Purge
              </button>
            ) : null}
          </div>
          {library === 'inModel' ? (
            <div className={gridClass} role="listbox" aria-label="In Model">
              <button
                type="button"
                role="option"
                aria-selected={activeId === null}
                className={`pf-material-item${activeId === null ? ' is-active' : ''}`}
                title="Default"
                onClick={() => setActiveId(null)}
              >
                <span className="pf-swatch" style={{ background: '#ffffff' }} aria-hidden="true" />
                <span className="pf-material-label">Default</span>
              </button>
              {inModel.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={activeId === m.id}
                  className={`pf-material-item${activeId === m.id ? ' is-active' : ''}`}
                  title={m.name}
                  onClick={() => setActiveId(m.id)}
                  onContextMenu={(e) => onItemContextMenu(e, m.id)}
                >
                  <span className="pf-swatch" style={swatchStyle(m, textureUrl(m))} aria-hidden="true" />
                  <span className="pf-material-label">{m.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className={gridClass} role="listbox" aria-label={library}>
              {libraryItems.map((m) => (
                <button key={m.key} type="button" role="option" className="pf-material-item" title={m.name} onClick={() => void app.commands.execute('material.fromLibrary', { key: m.key })}>
                  <span className="pf-swatch" style={{ background: rgbToCss(m.color), opacity: m.alpha ?? 1 }} aria-hidden="true" />
                  <span className="pf-material-label">{m.name}</span>
                </button>
              ))}
            </div>
          )}
          {menu ? (
            <ul className="pf-menu pf-materials-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
              <li className="pf-menu-item" role="menuitem" onClick={() => menuAction('delete')}>
                Delete
              </li>
              <li className="pf-menu-item" role="menuitem" onClick={() => menuAction('select')}>
                Select
              </li>
              <li className="pf-menu-item" role="menuitem" onClick={() => menuAction('edit')}>
                Edit
              </li>
              <li className="pf-menu-item" role="menuitem" onClick={() => menuAction('duplicate')}>
                Duplicate
              </li>
            </ul>
          ) : null}
        </>
      ) : (
        <EditTab material={active} textureUrl={textureUrl(active)} lockAspect={lockAspect} setLockAspect={setLockAspect} update={update} onFile={onFile} />
      )}
    </div>
  );
}

function EditTab({
  material,
  textureUrl,
  lockAspect,
  setLockAspect,
  update,
  onFile,
}: {
  material: Material | null;
  textureUrl: string | undefined;
  lockAspect: boolean;
  setLockAspect: (v: boolean) => void;
  update: (patch: Record<string, unknown>) => void;
  onFile: (e: ChangeEvent<HTMLInputElement>) => void;
}): JSX.Element {
  const [name, setName] = useState(material?.name ?? '');
  useEffect(() => setName(material?.name ?? ''), [material?.id, material?.name]);
  if (!material) return <p className="pf-ei-muted">Select a material to edit it (the default material cannot be edited).</p>;
  const css = rgbToCss(material.color);
  const [h, l, s] = rgbToHls(material.color);
  const rgb255 = material.color.map((c) => Math.round(c * 255)) as [number, number, number];
  const setRgb = (i: number, v: number) => {
    const next = [...material.color] as [number, number, number];
    next[i] = Math.min(1, Math.max(0, v / 255));
    update({ color: next });
  };
  const setHls = (i: number, v: number) => {
    const hls: [number, number, number] = [h, l, s];
    hls[i] = v;
    update({ color: hlsToRgb(hls[0], hls[1], hls[2]) });
  };
  const tex = material.texture;
  const aspect = tex && tex.widthM > 0 ? tex.heightM / tex.widthM : 1;
  const commitName = () => {
    const n = name.trim();
    if (n && n !== material.name) update({ name: n });
  };
  return (
    <div className="pf-form">
      <div className="pf-form-row">
        <span className="pf-form-label">Name</span>
        <input
          className="pf-form-input"
          aria-label="Material name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName();
            e.stopPropagation();
          }}
        />
      </div>
      <div className="pf-form-section">Color</div>
      <div className="pf-materials-color">
        <input type="color" aria-label="Color" value={css} onChange={(e) => update({ color: cssToRgb01(e.target.value) })} />
        {(['R', 'G', 'B'] as const).map((label, i) => (
          <NumberField key={label} label={label} value={rgb255[i]!} min={0} max={255} onCommit={(v) => setRgb(i, v)} />
        ))}
      </div>
      <div className="pf-materials-color">
        <span className="pf-form-label">HLS</span>
        <NumberField label="H" value={h} min={0} max={360} onCommit={(v) => setHls(0, v)} />
        <NumberField label="L" value={l} min={0} max={100} onCommit={(v) => setHls(1, v)} />
        <NumberField label="S" value={s} min={0} max={100} onCommit={(v) => setHls(2, v)} />
      </div>
      <div className="pf-form-row">
        <span className="pf-form-label">Opacity</span>
        <div className="pf-form-range">
          <input type="range" aria-label="Opacity" min={0} max={100} value={Math.round(material.alpha * 100)} onChange={(e) => update({ alpha: Number(e.target.value) / 100 })} />
          <span>{Math.round(material.alpha * 100)}%</span>
        </div>
      </div>
      <div className="pf-form-section">Texture</div>
      <label className="pf-form-check">
        <input
          type="checkbox"
          checked={!!tex}
          onChange={(e) => {
            if (!e.target.checked) update({ texture: null });
          }}
          disabled={!tex}
          aria-label="Use texture image"
        />
        Use texture image
      </label>
      <div className="pf-form-row">
        <span className="pf-form-label">Image</span>
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label="Texture image file" onChange={(e) => void onFile(e)} />
      </div>
      {tex ? (
        <>
          <div className="pf-form-row">
            <span className="pf-form-label">Width (m)</span>
            <NumberField
              label="Texture width"
              value={Number(tex.widthM.toFixed(4))}
              step={0.01}
              min={0.001}
              onCommit={(w) => update({ texture: lockAspect ? { widthM: w, heightM: w * aspect } : { widthM: w } })}
            />
          </div>
          <div className="pf-form-row">
            <span className="pf-form-label">Height (m)</span>
            <NumberField
              label="Texture height"
              value={Number(tex.heightM.toFixed(4))}
              step={0.01}
              min={0.001}
              onCommit={(hh) => update({ texture: lockAspect ? { heightM: hh, widthM: hh / (aspect || 1) } : { heightM: hh } })}
            />
          </div>
          <div className="pf-form-actions">
            <label className="pf-form-check">
              <input type="checkbox" checked={lockAspect} onChange={(e) => setLockAspect(e.target.checked)} aria-label="Lock aspect ratio" />
              Lock aspect
            </label>
            <button type="button" className="pf-btn" onClick={() => update({ texture: { widthM: 1, heightM: aspect } })} title="Reset size">
              Reset size
            </button>
            <label className="pf-form-check">
              <input type="checkbox" checked={tex.colorize} onChange={(e) => update({ texture: { colorize: e.target.checked } })} aria-label="Colorize" />
              Colorize
            </label>
          </div>
          {textureUrl ? <img src={textureUrl} alt="" style={{ maxWidth: '100%', maxHeight: 96, border: '1px solid var(--pf-border)' }} /> : null}
        </>
      ) : null}
    </div>
  );
}
