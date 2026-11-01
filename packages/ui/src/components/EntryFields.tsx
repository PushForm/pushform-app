// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import type { JSX, KeyboardEvent, RefObject } from 'react';
import { parseVcb } from '@pushform/commands';
import type { EntryField, VcbValue } from '@pushform/commands';
import { typedLengthUnit } from '@pushform/core';
import { useApp } from '../AppContext';
import type { AppInstance } from '../bootstrap';
import { useAppStore } from '../store';

/** Id of the field typing opens beside the pointer when the tool shows none. */
export const POINTER_FIELD = 'value';

export const entryInputId = (id: string): string => `pf-entry-${id}`;

/** Offset of a field shown beside the pointer, clear of the inference tooltip below it. */
const POINTER_OFFSET: readonly [number, number] = [70, -34];

/** Size of a field before it is measured in the page, matching `.pf-entry`. */
const FIELD_SIZE: readonly [number, number] = [78, 26];

/** Screen gap between a field and the point it is anchored on. */
const FIELD_GAP = 4;

/**
 * Centre of a `size` box placed beside screen point `at` in the direction of `toward`, wholly past
 * the line through `at` square to that direction and `FIELD_GAP` clear of it, so the box covers
 * neither the point nor a dimension line drawn through it. Centred on `at` when the direction does
 * not show on screen.
 */
export function clearOf(at: readonly [number, number], toward: readonly [number, number], size: readonly [number, number]): readonly [number, number] {
  const dx = toward[0] - at[0], dy = toward[1] - at[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) return at;
  const ux = dx / len, uy = dy / len;
  // How far the box reaches back toward `at` from its centre, measured along (ux, uy).
  const d = (Math.abs(ux) * size[0] + Math.abs(uy) * size[1]) / 2 + FIELD_GAP;
  return [at[0] + ux * d, at[1] + uy * d];
}

/** Width of a field that fits `text`, in the `ch` of its digits plus room for the caret. */
export function entryWidth(text: string): string {
  return `${Math.max(3, text.length) + 1}ch`;
}

/** Kinds a field reads as its own value; anything else typed (`8s`, `[x,y,z]`, `24r`, lists) goes to the tool as entered. */
const FIELD_KINDS = new Set<VcbValue['kind']>(['length', 'angle', 'slope']);

/** The fields to draw: the tool's, or the pointer field while one is being typed in. */
export function visibleFields(fields: readonly EntryField[], label: string, drafts: Readonly<Record<string, string>>, focus: string | null): readonly EntryField[] {
  if (fields.length) return fields;
  if (focus === POINTER_FIELD || POINTER_FIELD in drafts) return [{ id: POINTER_FIELD, label: label || 'Value', kind: 'number', value: '' }];
  return [];
}

/** Start typing `text` into the first visible field (from the global key handler). */
export function beginEntry(text: string): void {
  const s = useAppStore.getState();
  const first = s.entryFields[0]?.id ?? POINTER_FIELD;
  s.setEntryDraft(first, text);
}

/**
 * Value fields drawn over the viewport beside the geometry they measure. Typing replaces a
 * field's live value, Tab moves between fields and locks the value left, Enter applies the
 * fields to the active tool and Escape cancels.
 */
export function EntryFields({ pointer }: { pointer: RefObject<readonly [number, number]> }): JSX.Element | null {
  const app = useApp();
  const fields = useAppStore((s) => s.entryFields);
  const label = useAppStore((s) => s.vcbLabel);
  const drafts = useAppStore((s) => s.entryDrafts);
  const focus = useAppStore((s) => s.entryFocus);
  const error = useAppStore((s) => s.entryError);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  // Fields are anchored to world points: place them again whenever the view renders.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => app.viewport.events.on('render', rerender), [app]);
  // Fields grow with their text: place them again when a field's measured size changes.
  const sizes = useRef('');
  useLayoutEffect(() => {
    const now = [...inputs.current].map(([id, el]) => `${id}:${el.offsetWidth}x${el.offsetHeight}`).join(' ');
    if (now !== sizes.current) { sizes.current = now; rerender(); }
  });

  const shown = visibleFields(fields, label, drafts, focus);

  useEffect(() => {
    if (!focus) return;
    const input = inputs.current.get(focus);
    if (!input || document.activeElement === input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [focus, shown.length]);

  if (!shown.length) return null;

  const position = (f: EntryField): readonly [number, number] => {
    if (f.at) {
      const at = app.viewport.project(f.at);
      if (!f.away) return at;
      const el = inputs.current.get(f.id);
      const size: readonly [number, number] = el ? [el.offsetWidth, el.offsetHeight] : FIELD_SIZE;
      return clearOf(at, app.viewport.project([f.at[0] + f.away[0], f.at[1] + f.away[1], f.at[2] + f.away[2]]), size);
    }
    const p = pointer.current ?? [0, 0];
    return [p[0] + POINTER_OFFSET[0], p[1] + POINTER_OFFSET[1]];
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, f: EntryField) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      applyEntry(app, shown);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      leave(app);
      app.toolManager.cancel();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (!lockField(app, f)) return;
      const i = shown.findIndex((g) => g.id === f.id);
      const next = shown[(i + (e.shiftKey ? shown.length - 1 : 1)) % shown.length]!;
      const st = useAppStore.getState();
      st.setEntryDraft(next.id, st.entryDrafts[next.id] ?? '');
    }
  };

  return (
    <>
      {shown.map((f) => {
        const [x, y] = position(f);
        const draft = drafts[f.id];
        const editing = draft !== undefined;
        const cls = ['pf-entry', editing ? 'is-editing' : '', f.locked ? 'is-locked' : '', error === f.id ? 'is-error' : ''].filter(Boolean).join(' ');
        return (
          <input
            key={f.id}
            id={entryInputId(f.id)}
            ref={(el) => {
              if (el) inputs.current.set(f.id, el);
              else inputs.current.delete(f.id);
            }}
            className={cls}
            style={{ left: x, top: y, width: entryWidth(editing ? draft : f.value) }}
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={f.label}
            title={f.label}
            value={editing ? draft : f.value}
            onChange={(e) => useAppStore.getState().setEntryDraft(f.id, e.target.value)}
            onKeyDown={(e) => onKeyDown(e, f)}
            onFocus={() => {
              const st = useAppStore.getState();
              if (st.entryDrafts[f.id] === undefined) st.setEntryDraft(f.id, '');
              else st.setEntryFocus(f.id);
            }}
            onBlur={() => {
              const st = useAppStore.getState();
              // A value that is not locked into the preview does not outlive its field's focus.
              const locked = st.entryFields.find((g) => g.id === f.id)?.locked;
              if (!locked || !st.entryDrafts[f.id]) st.clearEntryDraft(f.id);
              if (st.entryFocus === f.id) st.setEntryFocus(null);
            }}
          />
        );
      })}
    </>
  );
}

function parse(app: AppInstance, text: string) {
  return parseVcb(text, typedLengthUnit(app.document.doc.state.meta.units));
}

/** Lock the typed value of `f` into the tool's preview (or release it when empty). False when the text cannot be read. */
function lockField(app: AppInstance, f: EntryField): boolean {
  const st = useAppStore.getState();
  const text = st.entryDrafts[f.id] ?? '';
  if (!text.trim()) {
    st.clearEntryDraft(f.id);
    app.toolManager.lockEntry(f.id, null);
    return true;
  }
  const r = parse(app, text);
  if (!r.ok) {
    st.setEntryError(f.id);
    return false;
  }
  if (FIELD_KINDS.has(r.value.kind)) app.toolManager.lockEntry(f.id, r.value);
  return true;
}

/** Read every typed field and apply them to the active tool; a field that cannot be read is marked and nothing applies. */
export function applyEntry(app: AppInstance, shown: readonly EntryField[]): void {
  const st = useAppStore.getState();
  const values: Record<string, VcbValue> = {};
  for (const f of shown) {
    const text = st.entryDrafts[f.id];
    if (text === undefined || !text.trim()) continue;
    const r = parse(app, text);
    if (!r.ok) {
      st.setEntryError(f.id);
      return;
    }
    if (f.id === POINTER_FIELD || !FIELD_KINDS.has(r.value.kind)) {
      // Anything the tool takes beyond the field's own value goes to it as entered.
      leave(app);
      app.toolManager.onVcb(r.value);
      return;
    }
    values[f.id] = r.value;
  }
  leave(app);
  app.toolManager.onEntry(values);
}

function leave(app: AppInstance): void {
  useAppStore.getState().clearEntry();
  app.viewport.container?.focus();
}
