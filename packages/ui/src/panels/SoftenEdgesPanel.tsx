// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { lastOperationOf, softenInfo } from '@pushform/commands';
import { entityRefKey } from '@pushform/model';
import { useApp } from '../AppContext';
import { useSelectionRefs } from '../hooks/useSelection';

const DEFAULT_ANGLE = 20;

interface Values {
  angleDeg: number;
  smooth: boolean;
  softenCoplanar: boolean;
}

/**
 * Soften Edges: angle slider, Smooth normals, Soften coplanar. Applies
 * `edges.soften` to the selection; successive edits of the same selection amend the same undo
 * step through `edit.redoWithParams` (so dragging the slider does not flood the stack).
 */
export function SoftenEdgesPanel(): JSX.Element {
  const app = useApp();
  const refs = useSelectionRefs();
  const refsKey = refs.map(entityRefKey).join('|');
  const info = softenInfo(app.document.doc.state, refs);
  const [values, setValues] = useState<Values>({ angleDeg: DEFAULT_ANGLE, smooth: true, softenCoplanar: false });

  // Reflect the current flags when the selection changes (not on every document change).
  useEffect(() => {
    const i = softenInfo(app.document.doc.state, app.document.selection.refs);
    setValues({
      angleDeg: i.angleDeg ?? DEFAULT_ANGLE,
      smooth: i.smooth ?? true,
      softenCoplanar: i.softenCoplanar ?? false,
    });
  }, [app, refsKey]);

  const apply = (next: Values): void => {
    setValues(next);
    if (refs.length === 0) return;
    const last = lastOperationOf(app.document);
    const sameSelection = last?.commandId === 'edges.soften' && sameRefs(last.params, refsKey);
    const params = { refs: refs.map((r) => ({ ...r })), ...next };
    if (sameSelection && app.commands.has('edit.redoWithParams')) app.commands.tryExecute('edit.redoWithParams', { params });
    else app.commands.tryExecute('edges.soften', params);
  };

  const disabled = refs.length === 0 || !app.commands.has('edges.soften');
  return (
    <div className="pf-form">
      <div className="pf-form-section">Angle between normals</div>
      <div className="pf-form-range">
        <input
          type="range"
          min={0}
          max={180}
          step={1}
          value={values.angleDeg}
          disabled={disabled}
          aria-label="Angle between normals"
          onChange={(e) => apply({ ...values, angleDeg: Number(e.target.value) })}
        />
        <input
          type="number"
          className="pf-form-input"
          min={0}
          max={180}
          step={1}
          value={values.angleDeg}
          disabled={disabled}
          aria-label="Angle in degrees"
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) apply({ ...values, angleDeg: Math.min(180, Math.max(0, v)) });
          }}
        />
      </div>
      <label className="pf-form-check">
        <input type="checkbox" checked={values.smooth} disabled={disabled} onChange={(e) => apply({ ...values, smooth: e.target.checked })} />
        Smooth normals
      </label>
      <label className="pf-form-check">
        <input
          type="checkbox"
          checked={values.softenCoplanar}
          disabled={disabled}
          onChange={(e) => apply({ ...values, softenCoplanar: e.target.checked })}
        />
        Soften coplanar
      </label>
      <p className="pf-form-note">
        {refs.length === 0
          ? 'Select edges, faces or bodies to soften.'
          : `${info.edges} edge${info.edges === 1 ? '' : 's'} in selection, ${info.soft} soft`}
      </p>
    </div>
  );
}

function sameRefs(params: unknown, refsKey: string): boolean {
  const refs = (params as { refs?: unknown } | null)?.refs;
  if (!Array.isArray(refs)) return false;
  try {
    return refs.map((r) => entityRefKey(r as Parameters<typeof entityRefKey>[0])).join('|') === refsKey;
  } catch {
    return false;
  }
}
