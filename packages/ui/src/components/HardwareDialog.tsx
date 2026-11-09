// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { containerAt } from '@pushform/model';
import { HARDWARE_SHAPES, resolveHardwareOptions } from '@pushform/kernel';
import type { HardwareShape } from '@pushform/kernel';
import { HARDWARE_FINISHES } from '@pushform/commands';
import type { HardwareFinish } from '@pushform/commands';
import { useApp } from '../AppContext';
import { Dialog, Field } from './DialogParts';

/** Optional dimensions use the selected family's defaults. Explicit entries are millimeters. */
export function HardwareDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const app = useApp();
  const selected = app.document.selection.refs.length === 1 ? app.document.selection.refs[0] : null;
  let selectedInstance;
  try {
    selectedInstance =
      selected?.kind === 'instance'
        ? containerAt(app.document.doc.state, selected.path).instances.get(selected.id)
        : null;
  } catch {
    selectedInstance = null;
  }
  const selectedDefinition = selectedInstance
    ? app.document.doc.state.definitions.get(selectedInstance.definitionId)
    : null;
  let seed: Record<string, unknown> = {};
  try {
    const data = JSON.parse(selectedDefinition?.description ?? '{}');
    if (data.generator === 'hardware') seed = data;
  } catch {
    /* A regular component has no generator parameters. */
  }
  const editId = seed.generator === 'hardware' ? selectedDefinition?.id : undefined;
  const [shape, setShape] = useState<HardwareShape>((seed.shape as HardwareShape) ?? 'bar-round');
  const [finish, setFinish] = useState<HardwareFinish>(
    (seed.finish as HardwareFinish) ?? 'satin-nickel',
  );
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(
      ['length', 'width', 'projection', 'spacing', 'grip', 'wall']
        .filter((k) => typeof seed[k] === 'number')
        .map((k) => [k, String(Number(seed[k]) * 1000)]),
    ),
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const defaults = resolveHardwareOptions({ shape });
  const fields: string[] =
    shape === 'backplate'
      ? ['width', 'wall', 'grip']
      : shape === 'half-moon'
        ? ['length', 'width', 'projection', 'spacing', 'wall']
        : shape === 'recessed-round'
          ? ['width', 'projection', 'wall']
          : shape === 'wire'
            ? ['spacing', 'projection', 'grip']
            : shape === 'bar-round' || shape === 'knob-t'
              ? ['length', 'projection', ...(shape === 'bar-round' ? ['spacing'] : []), 'grip']
              : shape.startsWith('knob-')
                ? ['knob-oval', 'knob-square', 'knob-pyramid', 'knob-t-square'].includes(shape)
                  ? ['length', 'width', 'projection', 'grip']
                  : ['width', 'projection', 'grip']
                : shape === 'ring'
                  ? ['width', 'projection', 'grip']
                  : shape.startsWith('recessed')
                    ? ['length', 'width', 'projection', 'wall']
                    : shape.startsWith('cup') || shape.startsWith('edge')
                      ? ['length', 'width', 'projection', 'spacing', 'wall']
                      : ['length', 'width', 'projection', 'spacing', 'grip'];
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const dims: Record<string, number> = {};
      for (const [key, text] of Object.entries(values).filter(([key]) => fields.includes(key)))
        if (text.trim()) {
          const v = Number(text);
          if (!Number.isFinite(v) || v < 0)
            throw new Error('Enter finite, nonnegative dimensions in millimeters.');
          dims[key] = v / 1000;
        }
      await app.commands.execute('hardware.create', {
        shape,
        finish,
        ...dims,
        ...(editId ? { replaceDefinitionId: editId, mountingPlane: seed.mountingPlane } : {}),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Hardware could not be generated.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Cabinet Hardware" onClose={busy ? () => {} : onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <Field label="Shape" htmlFor="hardware-shape">
          <select
            id="hardware-shape"
            value={shape}
            onChange={(e) => {
              setShape(e.target.value as HardwareShape);
              setValues({});
            }}
          >
            {HARDWARE_SHAPES.map((s) => (
              <option key={s} value={s}>
                {s.replaceAll('-', ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Finish" htmlFor="hardware-finish">
          <select
            id="hardware-finish"
            value={finish}
            onChange={(e) => setFinish(e.target.value as HardwareFinish)}
          >
            {Object.entries(HARDWARE_FINISHES).map(([key, v]) => (
              <option key={key} value={key}>
                {v.name.replace('Hardware — ', '')}
              </option>
            ))}
          </select>
        </Field>
        {editId && (
          <p>
            Regenerating changes all instances of this hardware component. Manual changes to its
            generated solids are replaced.
          </p>
        )}
        <p>Dimensions in mm. Leave a field empty to use the shape’s default.</p>
        {fields.map((key) => (
          <Field
            key={key}
            label={
              key === 'wall'
                ? 'Wall / plate thickness'
                : key === 'grip' && shape === 'backplate'
                  ? 'Screw hole diameter'
                  : key === 'spacing'
                    ? 'Mounting centers'
                    : key === 'width' && ['knob-hex', 'knob-octagon'].includes(shape)
                      ? 'Head across flats'
                      : key[0]!.toUpperCase() + key.slice(1)
            }
            htmlFor={'hardware-' + key}
          >
            <input
              id={'hardware-' + key}
              inputMode="decimal"
              placeholder={String(
                Math.round(Number(defaults[key as keyof typeof defaults]) * 100000) / 100,
              )}
              value={values[key] ?? ''}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            />
          </Field>
        ))}
        {error && (
          <p role="alert" className="pf-dialog-error">
            {error}
          </p>
        )}
        <div className="pf-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? 'Generating…' : editId ? 'Regenerate selected hardware' : 'Generate and place'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
