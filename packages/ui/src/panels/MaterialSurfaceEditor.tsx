// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { MATERIAL_FINISHES, materialAppearance, materialFinish } from '@pushform/model';
import type { Material, MaterialAppearance, MaterialFinish } from '@pushform/model';
import { MaterialPreview } from './MaterialPreview';
import { cssToRgb } from './colors';
import { rgbToCss } from '../engine/format';

export function SurfaceValue({
  label,
  value,
  max = 1,
  min = 0,
  change,
  preview,
}: {
  label: string;
  value: number;
  max?: number;
  min?: number;
  change: (value: number) => void;
  preview?: ((value: number | null) => void) | undefined;
}) {
  const [draft, setDraft] = useState<string | null>(null),
    [invalid, setInvalid] = useState(false),
    [sliding, setSliding] = useState<number | null>(null);
  const cancel = () => {
    setDraft(null);
    setInvalid(false);
    setSliding(null);
    preview?.(null);
  };
  const finishSlide = () => {
    if (sliding !== null) {
      change(sliding);
      setSliding(null);
      preview?.(null);
    }
  };
  const commit = () => {
    if (draft === null) return;
    const number = Number(draft);
    if (!draft.trim() || !Number.isFinite(number) || number < min || number > max) {
      setInvalid(true);
      return;
    }
    if (number !== value) change(number);
    setDraft(null);
    setInvalid(false);
  };
  // An external edit/undo ends any local gesture. Unmounting commits nothing.
  useEffect(() => {
    setDraft(null);
    setSliding(null);
    setInvalid(false);
  }, [value]);
  return (
    <div className="pf-material-value">
      <label className="pf-form-label">
        {label}
        <div className="pf-material-value-inputs">
          <input
            type="range"
            aria-label={label}
            min={min}
            max={max}
            step={max > 2 ? 0.1 : 0.01}
            value={sliding ?? value}
            onChange={(e) => {
              const n = Number(e.target.value);
              setSliding(n);
              preview?.(n);
            }}
            onPointerUp={finishSlide}
            onPointerCancel={cancel}
            onBlur={finishSlide}
            onKeyUp={(e) => {
              if (e.key !== 'Escape') finishSlide();
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
          />
          <input
            className="pf-form-input"
            type="number"
            aria-label={`${label} value`}
            min={min}
            max={max}
            step={0.01}
            value={draft ?? value}
            aria-invalid={invalid || undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setInvalid(false);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                commit();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
          />
        </div>
      </label>
      {invalid && (
        <p className="pf-form-note" role="alert">
          Enter a value from {min} to {max}.
        </p>
      )}
    </div>
  );
}

export function MaterialSurfaceEditor({
  material,
  textureUrl,
  normalUrl,
  imageName,
  update,
  onNormalFile,
  openLights,
}: {
  material: Material;
  textureUrl?: string | undefined;
  normalUrl?: string | undefined;
  imageName?: string | undefined;
  update: (patch: Record<string, unknown>) => void;
  onNormalFile: (event: ChangeEvent<HTMLInputElement>) => void;
  openLights: () => void;
}) {
  const appearance = materialAppearance(material),
    [draft, setDraft] = useState<Partial<MaterialAppearance> | null>(null);
  const lastEmission = useRef(1);
  const sampleMaterial = useMemo(
    () => (draft ? { ...material, appearance: { ...appearance, ...draft } } : material),
    [material, appearance, draft],
  );
  useEffect(() => {
    setDraft(null);
    if (appearance.emissionStrength > 0) lastEmission.current = appearance.emissionStrength;
  }, [appearance]);
  const patch = (a: Record<string, unknown>) => update({ appearance: a });
  const normal = appearance.normal;
  return (
    <>
      <MaterialPreview material={sampleMaterial} textureUrl={textureUrl} normalUrl={normalUrl} />
      <label className="pf-material-finish">
        Finish
        <select
          className="pf-form-input"
          aria-label="Finish"
          value={materialFinish(appearance)}
          onChange={(e) => {
            const p = MATERIAL_FINISHES[e.target.value as MaterialFinish];
            if (p) patch({ roughness: p.roughness, metalness: p.metalness, emissionStrength: 0 });
          }}
        >
          <option value="custom">Custom</option>
          {Object.entries(MATERIAL_FINISHES).map(([key, finish]) => (
            <option key={key} value={key}>
              {finish.name}
            </option>
          ))}
        </select>
      </label>
      <details className="pf-material-section" open>
        <summary>Surface</summary>
        <SurfaceValue
          label="Roughness"
          value={appearance.roughness}
          change={(roughness) => patch({ roughness })}
          preview={(v) => setDraft(v === null ? null : { roughness: v })}
        />
        <p className="pf-form-note">0 Polished · 1 Matte</p>
        <SurfaceValue
          label="Metalness"
          value={appearance.metalness}
          change={(metalness) => patch({ metalness })}
          preview={(v) => setDraft(v === null ? null : { metalness: v })}
        />
        <p className="pf-form-note">
          0 Nonmetal · 1 Metal. Painted metal normally uses a nonmetal coating.
        </p>
        <div className="pf-material-map">
          <strong>Normal image</strong>
          <p className="pf-form-note">Surface detail without changing geometry.</p>
          {normal && <p>{imageName ?? 'Missing image'}</p>}
          <label className="pf-material-file">
            {normal ? 'Replace image' : 'Choose image'}
            <input
              type="file"
              accept="image/png,image/jpeg"
              aria-label="Normal image file"
              onChange={onNormalFile}
            />
          </label>
          {normal && (
            <button className="pf-btn" onClick={() => patch({ normal: null })}>
              Remove normal image
            </button>
          )}
          {normal && !normalUrl && (
            <p className="pf-form-note" role="status">
              Normal image unavailable. Showing the base surface.
            </p>
          )}
        </div>
        {normal && (
          <>
            <SurfaceValue
              label="Normal strength"
              value={normal.strength}
              max={2}
              change={(strength) => patch({ normal: { strength } })}
              preview={(v) => setDraft(v === null ? null : { normal: { ...normal, strength: v } })}
            />
            <label className="pf-form-check">
              <input
                type="checkbox"
                aria-label="Flip green channel"
                checked={normal.flipGreen}
                onChange={(e) => patch({ normal: { flipGreen: e.target.checked } })}
              />
              Flip green channel
            </label>
            {!material.texture && (
              <>
                <SurfaceValue
                  label="Normal tile width (m)"
                  value={normal.widthM}
                  min={0.001}
                  max={1000}
                  change={(widthM) => patch({ normal: { widthM } })}
                />
                <SurfaceValue
                  label="Normal tile height (m)"
                  value={normal.heightM}
                  min={0.001}
                  max={1000}
                  change={(heightM) => patch({ normal: { heightM } })}
                />
              </>
            )}
          </>
        )}
        <p className="pf-form-note">
          Environment reflections show the lighting environment, not nearby model objects.
        </p>
      </details>
      <details className="pf-material-section" open>
        <summary>Emission</summary>
        <label className="pf-form-check">
          <input
            type="checkbox"
            aria-label="Enable emission"
            checked={appearance.emissionStrength > 0}
            onChange={(e) =>
              patch({ emissionStrength: e.target.checked ? lastEmission.current : 0 })
            }
          />
          Enable emission
        </label>
        {appearance.emissionStrength > 0 && (
          <>
            <label className="pf-form-row">
              <span>Emission color</span>
              <input
                type="color"
                aria-label="Emission color"
                value={rgbToCss(appearance.emissionColor)}
                onChange={(e) => patch({ emissionColor: cssToRgb(e.target.value) })}
              />
            </label>
            <SurfaceValue
              label="Emission strength"
              value={appearance.emissionStrength}
              max={100}
              change={(emissionStrength) => patch({ emissionStrength })}
              preview={(v) => setDraft(v === null ? null : { emissionStrength: v })}
            />
            <p className="pf-form-note">
              Makes the surface self-lit. Add a scene light to light nearby objects.
            </p>
            <button className="pf-btn" onClick={openLights}>
              Open scene lights
            </button>
          </>
        )}
      </details>
    </>
  );
}
