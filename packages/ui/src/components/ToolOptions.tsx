// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type JSX } from 'react';
import { typedLengthUnit } from '@pushform/core';
import { parseVcb, type EntryField } from '@pushform/commands';
import type { AppInstance } from '../bootstrap';

/** Extension-owned text and expression fields use the host's current tool options bar. */
export function ToolOptionsFields({ app, fields }: { app: AppInstance; fields: readonly EntryField[] }): JSX.Element {
  return <>{fields.map(field => <OptionField key={field.id} app={app} field={field} />)}</>;
}
function OptionField({ app, field }: { app: AppInstance; field: EntryField }): JSX.Element {
  const input = useRef<HTMLInputElement>(null), [draft, setDraft] = useState(field.value), submitted = useRef<string | null>(null);
  useEffect(() => { if (document.activeElement !== input.current) setDraft(field.value); }, [field.value]);
  const commit = (fromBlur = false): void => {
    if (draft === field.value || fromBlur && submitted.current === draft) return;
    submitted.current = draft;
    const unit = typedLengthUnit(app.document.doc.state.meta.units);
    if (!app.toolManager.onRawEntry({ [field.id]: draft }, unit)) {
      const parsed = parseVcb(draft, unit);
      if (parsed.ok) app.toolManager.onEntry({ [field.id]: parsed.value });
      else { app.store.getState().setNotice(parsed.error.error); return; }
    }
    if (!fromBlur) app.viewport.container?.focus();
  };
  return <label className="pf-tob-item pf-tob-extension-field"><span className="pf-tob-label">{field.label}</span>
    <input data-tob-control className="pf-tob-input" size={field.kind === 'text' ? 18 : 10} ref={input} type="text" value={draft} autoComplete="off" spellCheck={false} maxLength={field.kind === 'text' ? 200 : 500}
      onChange={event => { submitted.current = null; setDraft(event.target.value); }} onBlur={() => commit(true)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />
  </label>;
}
