// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { lastOperationOf } from '@pushform/commands';
import type { LastOperation } from '@pushform/commands';
import { useApp } from '../AppContext';
import { describeSchema, parseNumberInput } from './zodForm';
import type { FieldSpec } from './zodForm';

/** Re-render when the undo stack changes. */
function useUndoVersion(): number {
  const app = useApp();
  const [v, setV] = useState(0);
  useEffect(() => app.document.undoStack.events.on('change', () => setV((x) => x + 1)), [app]);
  return v;
}

/**
 * Last Operation (Blender's adjust-last-operation panel): the top undo entry's label and a form
 * generated from its command's zod schema. Editing a field runs `edit.redoWithParams`, which
 * undoes the entry and re-executes the command with the new value. "Repeat last" runs it again.
 */
export function LastOperationPanel(): JSX.Element {
  const app = useApp();
  useUndoVersion();
  const last = lastOperationOf(app.document);
  if (!last) return <p className="pf-ei-muted">Nothing to adjust yet.</p>;
  const fields = last.commandId ? describeSchema(app.commands.get(last.commandId)?.params) : null;
  const canEdit = last.editable && app.commands.has('edit.redoWithParams');
  const update = (key: string, value: unknown): void => {
    app.commands.tryExecute('edit.redoWithParams', { params: { [key]: value } });
  };
  return (
    <div className="pf-form">
      <h3 className="pf-ei-title">{last.label}</h3>
      {last.commandId ? <p className="pf-form-note">{last.commandId}</p> : <p className="pf-form-note">Not re-executable (no command recorded).</p>}
      {fields && canEdit ? (
        fields.map((f) => <Field key={`${last.commandId}:${f.key}`} spec={f} last={last} onChange={update} />)
      ) : last.params !== null && last.params !== undefined ? (
        <pre className="pf-form-textarea" aria-label="Parameters">
          {JSON.stringify(last.params, null, 1)}
        </pre>
      ) : null}
      <div className="pf-form-actions">
        <button type="button" className="pf-btn" disabled={!last.editable || !app.commands.isEnabled('edit.repeatLast')} onClick={() => app.commands.tryExecute('edit.repeatLast')}>
          Repeat last
        </button>
      </div>
    </div>
  );
}

function valueOf(last: LastOperation, key: string): unknown {
  const p = last.params as Record<string, unknown> | null | undefined;
  return p && typeof p === 'object' ? p[key] : undefined;
}

function Field({ spec, last, onChange }: { spec: FieldSpec; last: LastOperation; onChange: (key: string, value: unknown) => void }): JSX.Element {
  const value = valueOf(last, spec.key);
  const label = spec.key;
  switch (spec.kind) {
    case 'boolean':
      return (
        <label className="pf-form-check">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(spec.key, e.target.checked)} />
          {label}
        </label>
      );
    case 'enum':
      return (
        <div className="pf-form-row">
          <span className="pf-form-label">{label}</span>
          <select className="pf-form-select" aria-label={label} value={value === undefined ? '' : String(value)} onChange={(e) => onChange(spec.key, e.target.value)}>
            {value === undefined ? <option value="">—</option> : null}
            {spec.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      );
    case 'number':
      return (
        <div className="pf-form-row">
          <span className="pf-form-label">{label}</span>
          <CommitInput
            label={label}
            type="number"
            text={value === undefined || value === null ? '' : String(value)}
            onCommit={(t) => {
              const n = parseNumberInput(t, spec.int);
              if (n !== null) onChange(spec.key, n);
              return n !== null || (spec.optional && t.trim() === '');
            }}
          />
        </div>
      );
    case 'string':
      return (
        <div className="pf-form-row">
          <span className="pf-form-label">{label}</span>
          <CommitInput label={label} type="text" text={typeof value === 'string' ? value : ''} onCommit={(t) => (onChange(spec.key, t), true)} />
        </div>
      );
    case 'vec3': {
      const v = Array.isArray(value) && value.length === 3 ? (value as number[]) : [0, 0, 0];
      return (
        <div className="pf-form-row">
          <span className="pf-form-label">{label}</span>
          <div className="pf-form-vec">
            {(['x', 'y', 'z'] as const).map((axis, i) => (
              <CommitInput
                key={axis}
                label={`${label} ${axis}`}
                type="number"
                text={String(v[i] ?? 0)}
                onCommit={(t) => {
                  const n = parseNumberInput(t, false);
                  if (n === null) return false;
                  const next = [...v];
                  next[i] = n;
                  onChange(spec.key, next);
                  return true;
                }}
              />
            ))}
          </div>
        </div>
      );
    }
    case 'json':
      return (
        <div className="pf-form-row">
          <span className="pf-form-label">{label}</span>
          <CommitInput
            label={label}
            type="textarea"
            text={value === undefined ? '' : JSON.stringify(value)}
            onCommit={(t) => {
              try {
                onChange(spec.key, t.trim() === '' ? undefined : JSON.parse(t));
                return true;
              } catch {
                return false;
              }
            }}
          />
        </div>
      );
  }
}

/** Text input that commits on Enter / blur; the commit callback returns false to flag an error. */
function CommitInput({ label, type, text, onCommit }: { label: string; type: 'number' | 'text' | 'textarea'; text: string; onCommit: (t: string) => boolean }): JSX.Element {
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState(false);
  useEffect(() => {
    setDraft(text);
    setError(false);
  }, [text]);
  const commit = (): void => {
    if (draft === text) return;
    setError(!onCommit(draft));
  };
  const cls = `${type === 'textarea' ? 'pf-form-textarea' : 'pf-form-input'}${error ? ' is-error' : ''}`;
  if (type === 'textarea') {
    return <textarea className={cls} aria-label={label} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />;
  }
  return (
    <input
      className={cls}
      aria-label={label}
      type={type}
      step="any"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        e.stopPropagation();
      }}
    />
  );
}
