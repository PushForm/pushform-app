// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useRef } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { parseVcb } from '@pushform/commands';
import { typedLengthUnit } from '@pushform/core';
import { useApp } from '../AppContext';
import { useAppStore } from '../store';

export const VCB_INPUT_ID = 'pf-vcb-input';

/** Measurements box: shows the live value; typing replaces it; Enter submits to the active tool. */
export function MeasurementsBox(): JSX.Element {
  const app = useApp();
  const ref = useRef<HTMLInputElement>(null);
  const label = useAppStore((s) => s.vcbLabel);
  const live = useAppStore((s) => s.vcbValue);
  const input = useAppStore((s) => s.vcbInput);
  const editing = useAppStore((s) => s.vcbEditing);
  const error = useAppStore((s) => s.vcbError);
  const setVcbInput = useAppStore((s) => s.setVcbInput);
  const setVcbError = useAppStore((s) => s.setVcbError);

  const finish = () => {
    setVcbInput('', false);
    ref.current?.blur();
    app.viewport.container?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // A bare number is a length in the model's units.
      const r = parseVcb(input, typedLengthUnit(app.document.doc.state.meta.units));
      if (!r.ok) {
        setVcbError(true);
        return;
      }
      app.toolManager.onVcb(r.value);
      finish();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish();
      app.toolManager.cancel();
    }
    e.stopPropagation();
  };

  return (
    <label className={`pf-vcb${error ? ' is-error' : ''}`} htmlFor={VCB_INPUT_ID}>
      <span className="pf-vcb-label">{label || 'Measurements'}</span>
      <input
        id={VCB_INPUT_ID}
        ref={ref}
        className="pf-vcb-input"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={editing ? input : live}
        placeholder=""
        aria-label={label ? `${label} (Measurements)` : 'Measurements'}
        onChange={(e) => setVcbInput(e.target.value, true)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          // Read the store directly: the global key handler may have just seeded the input.
          if (!useAppStore.getState().vcbEditing) setVcbInput('', true);
        }}
        onBlur={() => {
          if (!useAppStore.getState().vcbInput) setVcbInput('', false);
        }}
      />
    </label>
  );
}
