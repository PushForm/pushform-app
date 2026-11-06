// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useId, useRef, useState } from 'react';
import { formatLength, parseLength, typedLengthUnit } from '@pushform/core';
import type { UnitSettings } from '@pushform/core';
import { ENVIRONMENT_PRESETS, environmentPreset } from '@pushform/model';
import type { EnvironmentSettings, SceneLight, Style } from '@pushform/model';
import type { EnvironmentPatch, SceneLightPatch } from '@pushform/commands';
import { useApp } from '../AppContext';
import { useDocumentState } from '../hooks/useDocument';
import { applyDocumentView } from '../engine/viewSync';
import { formatDate, formatTime, parseDate, parseTime } from './ShadowsPanel';
import { cssToRgb, rgbToCss } from './colors';

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  change,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  change(value: number): void;
}) {
  const [text, setText] = useState<string | null>(null),
    [invalid, setInvalid] = useState(false);
  const commit = () => {
    if (text === null) return;
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value) || value < min || value > max) {
      setInvalid(true);
      return;
    }
    change(value);
    setText(null);
    setInvalid(false);
  };
  return (
    <label className="pf-env-field">
      {label}
      <input
        type="number"
        className="pf-form-input"
        aria-invalid={invalid || undefined}
        min={min}
        max={max}
        step={step}
        value={text ?? Number(value.toFixed(3))}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(null);
            setInvalid(false);
          }
        }}
      />
      {invalid && (
        <span className="pf-form-note" role="alert">
          Enter a value from {min} to {max}.
        </span>
      )}
    </label>
  );
}
function LengthField({
  label,
  value,
  units,
  change,
}: {
  label: string;
  value: number;
  units: UnitSettings;
  change(value: number): void;
}) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const value = parseLength(text, typedLengthUnit(units));
    if (value !== null) change(value);
    setText(null);
  };
  return (
    <label className="pf-env-field">
      {label}
      <input
        className="pf-form-input"
        value={text ?? formatLength(value, units)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setText(null);
        }}
      />
    </label>
  );
}
function Check({
  label,
  value,
  change,
}: {
  label: string;
  value: boolean;
  change(value: boolean): void;
}) {
  return (
    <label className="pf-form-check">
      <input type="checkbox" checked={value} onChange={(e) => change(e.target.checked)} />
      {label}
    </label>
  );
}
function Slider({
  label,
  value,
  max = 1,
  change,
}: {
  label: string;
  value: number;
  max?: number;
  change(value: number): void;
}) {
  return (
    <label className="pf-env-field">
      <span className="pf-env-between">
        {label}
        <output>{Math.round(value * 100)}%</output>
      </span>
      <input
        type="range"
        min={0}
        max={max * 100}
        value={Math.round(value * 100)}
        onChange={(e) => change(Number(e.target.value) / 100)}
      />
    </label>
  );
}

export function EnvironmentPane({ style }: { style: Style }) {
  const tabId = useId();
  const app = useApp(),
    state = useDocumentState();
  const [section, setSection] = useState<'studio' | 'sun' | 'lights'>('studio');
  const [draft, setDraft] = useState<EnvironmentSettings | null>(null);
  const [message, setMessage] = useState(''),
    [saveName, setSaveName] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null),
    [adding, setAdding] = useState(false);
  const [lightType, setLightType] = useState<SceneLight['type']>('point'),
    [lightName, setLightName] = useState('Light');
  const [lumens, setLumens] = useState(800),
    [temperature, setTemperature] = useState(3000);
  const input = useRef<HTMLInputElement>(null);
  const lights = state.sceneLights ?? [],
    shadow = state.shadows;
  const env = draft ??
    style.environment ?? {
      ...environmentPreset(shadow.useSunForShading || shadow.enabled ? 'daylight' : 'bright'),
      sunShadows: shadow.enabled,
    };
  const light = lights.find((light) => light.id === selected);
  useEffect(() => {
    setDraft(null);
    setSaveName(null);
    setMessage('');
  }, [style.id, style.environment]);
  useEffect(() => {
    if (draft)
      app.viewport.setEnvironment(
        draft,
        state.sceneLights ?? [],
        draft.skyboxImageId ? app.document.images.objectUrl(draft.skyboxImageId) : undefined,
      );
    else applyDocumentView(app.viewport, state, app.document.images);
  }, [app, draft, state]);
  useEffect(
    () => () => applyDocumentView(app.viewport, app.document.doc.state, app.document.images),
    [app],
  );
  useEffect(() => {
    app.viewport.setLightSelection(selected);
    return () => app.viewport.setLightSelection(null);
  }, [app, selected]);
  const patch = (patch: EnvironmentPatch) => {
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    setDraft({ ...env, preset: 'custom', ...defined });
    setMessage('');
  };
  const run = (id: string, params: unknown) => {
    const result = app.commands.tryExecute(id, params);
    if (!result.ok)
      setMessage(
        result.error instanceof Error ? result.error.message : 'The change could not be applied.',
      );
    return result.ok;
  };
  const updateLight = (patch: SceneLightPatch) => {
    if (light) run('light.update', { id: light.id, patch });
  };
  const pose = (field: 'position' | 'target', axis: number, value: number) => {
    if (!light) return;
    const vector = [...light[field]] as [number, number, number];
    vector[axis] = value;
    updateLight({ [field]: vector });
  };
  const upload = async (file?: File) => {
    if (!file) return;
    try {
      if (
        !['image/png', 'image/jpeg'].includes(file.type) ||
        !file.size ||
        file.size > 16 * 1024 * 1024
      )
        throw new Error('Choose a PNG or JPEG skybox of up to 16 MiB.');
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();
      if (width > 8192 || height > 4096)
        throw new Error('Choose a skybox no larger than 8192 × 4096 pixels.');
      const asset = await app.document.images.put(
        new Uint8Array(await file.arrayBuffer()),
        file.type,
        file.name,
        { width, height },
      );
      patch({ sky: 'image', skyboxImageId: asset.id });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The skybox could not be read.');
    }
  };
  const choosePreset = (value: string) => {
    if (value === 'legacy' || value === 'custom') return;
    const next = environmentPreset(value as 'bright' | 'soft' | 'daylight' | 'night');
    setDraft(next);
    setMessage('');
    setSection(value === 'daylight' ? 'sun' : value === 'night' ? 'lights' : 'studio');
  };
  const save = (asNew: boolean) => {
    if (
      run(
        asNew ? 'environment.saveStyle' : 'environment.set',
        asNew ? { name: saveName, patch: env } : { patch: env },
      )
    ) {
      setDraft(null);
      setSaveName(null);
      setMessage(asNew ? 'Style saved.' : 'Style updated.');
    }
  };
  return (
    <div className="pf-environment">
      <label className="pf-env-field">
        Environment preset
        <select
          className="pf-form-select"
          value={draft?.preset ?? style.environment?.preset ?? 'legacy'}
          onChange={(e) => choosePreset(e.target.value)}
        >
          {!style.environment && !draft && <option value="legacy">Current file lighting</option>}
          {ENVIRONMENT_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>
      <div
        className="pf-tabs pf-tabs-sub pf-env-tabs"
        role="tablist"
        aria-label="Environment controls"
      >
        {(['studio', 'sun', 'lights'] as const).map((id, index, tabs) => (
          <button
            type="button"
            role="tab"
            id={`${tabId}-${id}`}
            aria-controls={`${tabId}-panel`}
            tabIndex={section === id ? 0 : -1}
            className={`pf-tab${section === id ? ' is-active' : ''}`}
            aria-selected={section === id}
            key={id}
            onClick={() => setSection(id)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? tabs[(index + 1) % tabs.length]
                  : event.key === 'ArrowLeft'
                    ? tabs[(index + tabs.length - 1) % tabs.length]
                    : event.key === 'Home'
                      ? tabs[0]
                      : event.key === 'End'
                        ? tabs[tabs.length - 1]
                        : undefined;
              if (next) {
                event.preventDefault();
                setSection(next);
                document.getElementById(`${tabId}-${next}`)?.focus();
              }
            }}
          >
            {id === 'studio' ? 'Studio' : id === 'sun' ? 'Sun & sky' : 'Scene lights'}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${section}`}>
        {section === 'studio' && (
          <>
            <Check
              label="Studio lighting"
              value={env.studioEnabled}
              change={(studioEnabled) => patch({ studioEnabled })}
            />
            <Slider
              label="Brightness"
              value={env.brightness}
              max={1.5}
              change={(brightness) => patch({ brightness })}
            />
            <Slider label="Fill light" value={env.fill} change={(fill) => patch({ fill })} />
            <Slider label="Directional light" value={env.key} change={(key) => patch({ key })} />
            <Slider
              label="View-facing light"
              value={env.facing}
              change={(facing) => patch({ facing })}
            />
            <div className="pf-env-grid">
              <NumberField
                label="Horizontal direction (°)"
                value={env.azimuth}
                min={-180}
                max={180}
                change={(azimuth) => patch({ azimuth })}
              />
              <NumberField
                label="Elevation (°)"
                value={env.elevation}
                min={-90}
                max={90}
                change={(elevation) => patch({ elevation })}
              />
            </div>
            <Check
              label="Follow camera"
              value={env.followCamera}
              change={(followCamera) => patch({ followCamera })}
            />
            <Check
              label="Cast soft shadows"
              value={env.studioShadows}
              change={(studioShadows) => patch({ studioShadows })}
            />
          </>
        )}
        {section === 'sun' && (
          <>
            <Check
              label="Use sun for lighting"
              value={env.sunEnabled}
              change={(sunEnabled) => patch({ sunEnabled })}
            />
            <div className="pf-env-grid">
              <label className="pf-env-field">
                Date (MM/DD)
                <input
                  className="pf-form-input"
                  defaultValue={formatDate(shadow.month, shadow.day)}
                  key={`${shadow.month}/${shadow.day}`}
                  onBlur={(e) => {
                    const value = parseDate(e.target.value);
                    if (value) run('shadows.set', { patch: value });
                  }}
                />
              </label>
              <label className="pf-env-field">
                Time
                <input
                  className="pf-form-input"
                  type="time"
                  value={formatTime(shadow.time)}
                  onChange={(e) => {
                    const time = parseTime(e.target.value);
                    if (time !== null) run('shadows.set', { patch: { time } });
                  }}
                />
              </label>
            </div>
            <NumberField
              label="Time zone (UTC hours)"
              value={shadow.utcOffsetHours}
              min={-12}
              max={14}
              step={0.25}
              change={(utcOffsetHours) => run('shadows.set', { patch: { utcOffsetHours } })}
            />
            <Slider
              label="Sun intensity"
              value={env.sunIntensity}
              max={2}
              change={(sunIntensity) => patch({ sunIntensity })}
            />
            <Check
              label="Cast sun shadows"
              value={env.sunShadows}
              change={(sunShadows) => patch({ sunShadows })}
            />
            <Slider
              label="Sky light"
              value={env.skyLight}
              max={2}
              change={(skyLight) => patch({ skyLight })}
            />
            <details>
              <summary>Project location &amp; north</summary>
              <div className="pf-env-grid">
                <NumberField
                  label="Latitude"
                  value={shadow.latitude}
                  min={-90}
                  max={90}
                  step={0.001}
                  change={(latitude) =>
                    run('shadows.setLocation', { latitude, longitude: shadow.longitude })
                  }
                />
                <NumberField
                  label="Longitude"
                  value={shadow.longitude}
                  min={-180}
                  max={180}
                  step={0.001}
                  change={(longitude) =>
                    run('shadows.setLocation', { latitude: shadow.latitude, longitude })
                  }
                />
              </div>
              <NumberField
                label="Model north (°)"
                value={shadow.northAngle}
                min={0}
                max={360}
                change={(northAngle) =>
                  run('shadows.setLocation', {
                    latitude: shadow.latitude,
                    longitude: shadow.longitude,
                    northAngle,
                  })
                }
              />
            </details>
          </>
        )}
        {section === 'lights' && (
          <>
            <Check
              label="Show scene lights"
              value={env.sceneLightsEnabled}
              change={(sceneLightsEnabled) => patch({ sceneLightsEnabled })}
            />
            {!lights.length && <p className="pf-form-note">No lights in this model.</p>}
            <div className="pf-env-light-list">
              {lights.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`pf-btn${selected === item.id ? ' is-active' : ''}`}
                  onClick={() => setSelected(item.id)}
                >
                  {item.name}
                  {!item.enabled ? ' (off)' : ''}
                </button>
              ))}
            </div>
            <button type="button" className="pf-btn" onClick={() => setAdding(!adding)}>
              Add light…
            </button>
            {adding && (
              <div className="pf-env-editor">
                <label className="pf-env-field">
                  Type
                  <select
                    className="pf-form-select"
                    value={lightType}
                    onChange={(e) => setLightType(e.target.value as SceneLight['type'])}
                  >
                    <option value="point">Point light</option>
                    <option value="spot">Spot light</option>
                    <option value="area">Area light</option>
                  </select>
                </label>
                <label className="pf-env-field">
                  Name
                  <input
                    className="pf-form-input"
                    value={lightName}
                    onChange={(e) => setLightName(e.target.value)}
                  />
                </label>
                <NumberField
                  label="Output (lumens)"
                  value={lumens}
                  min={0}
                  max={100000}
                  change={setLumens}
                />
                <NumberField
                  label="Temperature (K)"
                  value={temperature}
                  min={1000}
                  max={12000}
                  change={setTemperature}
                />
                <button
                  type="button"
                  className="pf-btn"
                  onClick={() => {
                    patch({ sceneLightsEnabled: true });
                    if (
                      run('light.place', { name: lightName, type: lightType, lumens, temperature })
                    )
                      setAdding(false);
                  }}
                >
                  Place in model
                </button>
              </div>
            )}
            {light && (
              <div className="pf-env-editor">
                <label className="pf-env-field">
                  Light name
                  <input
                    className="pf-form-input"
                    key={`${light.id}-${light.name}`}
                    defaultValue={light.name}
                    onBlur={(e) => {
                      if (e.target.value !== light.name) updateLight({ name: e.target.value });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                  />
                </label>
                <Check
                  label="Light enabled"
                  value={light.enabled}
                  change={(enabled) => updateLight({ enabled })}
                />
                <Check
                  label="Cast shadows"
                  value={light.castShadow}
                  change={(castShadow) => updateLight({ castShadow })}
                />
                <NumberField
                  label="Output (lumens)"
                  value={light.lumens}
                  min={0}
                  max={100000}
                  change={(lumens) => updateLight({ lumens })}
                />
                <NumberField
                  label="Temperature (K)"
                  value={light.temperature}
                  min={1000}
                  max={12000}
                  change={(temperature) => updateLight({ temperature })}
                />
                <div className="pf-form-section">Position</div>
                <div className="pf-env-grid">
                  {(['X', 'Y', 'Z'] as const).map((label, axis) => (
                    <LengthField
                      key={label}
                      label={label}
                      value={light.position[axis]!}
                      units={state.meta.units}
                      change={(value) => pose('position', axis, value)}
                    />
                  ))}
                </div>
                {light.type !== 'point' && (
                  <>
                    <div className="pf-form-section">Aim at</div>
                    <div className="pf-env-grid">
                      {(['X', 'Y', 'Z'] as const).map((label, axis) => (
                        <LengthField
                          key={label}
                          label={`Target ${label}`}
                          value={light.target[axis]!}
                          units={state.meta.units}
                          change={(value) => pose('target', axis, value)}
                        />
                      ))}
                    </div>
                  </>
                )}
                {light.type === 'spot' && (
                  <NumberField
                    label="Beam angle (°)"
                    value={light.angle}
                    min={1}
                    max={178}
                    change={(angle) => updateLight({ angle })}
                  />
                )}
                {light.type === 'area' && (
                  <div className="pf-env-grid">
                    <LengthField
                      label="Width"
                      value={light.width}
                      units={state.meta.units}
                      change={(width) => updateLight({ width })}
                    />
                    <LengthField
                      label="Height"
                      value={light.height}
                      units={state.meta.units}
                      change={(height) => updateLight({ height })}
                    />
                  </div>
                )}
                <button
                  type="button"
                  className="pf-btn"
                  onClick={() => {
                    if (run('light.delete', { id: light.id })) setSelected(null);
                  }}
                >
                  Delete light
                </button>
              </div>
            )}
            <p className="pf-form-note">
              Sun, sky light and scene lights can be adjusted independently.
            </p>
          </>
        )}
      </div>
      <div className="pf-form-section">Background</div>
      <label className="pf-env-field">
        Sky
        <select
          className="pf-form-select"
          value={env.sky}
          onChange={(e) => {
            if (e.target.value === 'image' && !env.skyboxImageId) input.current?.click();
            else patch({ sky: e.target.value as EnvironmentSettings['sky'] });
          }}
        >
          <option value="solid">Solid color</option>
          <option value="clear">Clear sky</option>
          <option value="overcast">Overcast sky</option>
          <option value="night">Night sky</option>
          <option value="image">Skybox image</option>
        </select>
      </label>
      {env.sky === 'solid' && (
        <label className="pf-env-between">
          Color
          <input
            type="color"
            aria-label="Environment background color"
            value={rgbToCss(style.background.color)}
            onChange={(e) =>
              run('style.update', { patch: { background: { color: cssToRgb(e.target.value) } } })
            }
          />
        </label>
      )}
      {env.sky === 'image' && (
        <>
          <p className="pf-form-note">
            {env.skyboxImageId
              ? app.document.images.asset(env.skyboxImageId)?.name
              : 'Choose an equirectangular PNG or JPEG.'}
          </p>
          <button type="button" className="pf-btn" onClick={() => input.current?.click()}>
            Replace skybox…
          </button>
          <NumberField
            label="Sky rotation (°)"
            value={env.skyRotation}
            min={-180}
            max={180}
            change={(skyRotation) => patch({ skyRotation })}
          />
        </>
      )}
      <input
        ref={input}
        type="file"
        aria-label="Choose skybox image"
        hidden
        accept="image/png,image/jpeg"
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <div className="pf-form-actions">
        <button type="button" className="pf-btn" disabled={!draft} onClick={() => save(false)}>
          Update style
        </button>
        <button type="button" className="pf-btn" onClick={() => setSaveName(`${style.name} copy`)}>
          Save as…
        </button>
        {draft && (
          <button type="button" className="pf-btn" onClick={() => setDraft(null)}>
            Revert preview
          </button>
        )}
      </div>
      {saveName !== null && (
        <div className="pf-env-editor">
          <label className="pf-env-field">
            New style name
            <input
              className="pf-form-input"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="pf-btn"
            disabled={!saveName.trim()}
            onClick={() => save(true)}
          >
            Save style
          </button>
        </div>
      )}
      <p className="pf-form-note" role="status">
        {message ||
          (draft
            ? 'Preview — update or save the style to keep these changes.'
            : 'Saved with this model.')}
      </p>
    </div>
  );
}
