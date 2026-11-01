// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { clearOf, entryWidth } from './EntryFields';
import type { LayoutEntryField, LayoutEntrySegment } from './layoutEntry';

/** Offset of a field shown beside the pointer, clear of the snap tooltip and readouts below it. */
const POINTER_OFFSET: readonly [number, number] = [56, -26];
const FIELD_SIZE: readonly [number, number] = [78, 26];

export interface LayoutEntryFieldsProps {
  readonly fields: readonly LayoutEntryField[];
  readonly segments: readonly LayoutEntrySegment[];
  readonly pageSize: readonly [number, number];
  /** Screen pixels per page millimeter. */
  readonly scale: number;
  /** Pointer on the page, for fields without an anchor. */
  readonly pointer: readonly [number, number] | null;
  readonly drafts: Readonly<Record<string, string>>;
  readonly focus: string | null;
  readonly error: string | null;
  readonly onDraft: (id: string, text: string) => void;
  readonly onFocus: (id: string) => void;
  /** Focus left a field; a value that is not locked does not outlive it. */
  readonly onBlur: (id: string) => void;
  /** Tab or Shift+Tab out of a field; false keeps focus there. */
  readonly onTab: (id: string, back: boolean) => void;
  readonly onEnter: () => void;
  readonly onEscape: () => void;
}

/**
 * Value fields and their gray dimension lines over the Layout page. The focused field shows its
 * live value selected, so typing replaces it; Tab moves between fields, Enter applies and Escape
 * cancels.
 */
export function LayoutEntryFields(props: LayoutEntryFieldsProps): JSX.Element | null {
  const { fields, segments, pageSize, scale, pointer, drafts, focus, error } = props;
  const inputs = useRef(new Map<string, HTMLInputElement>());
  // Measured sizes place the fields; place them again when a field's size changes, as it does with its text.
  const [, remeasure] = useReducer((n: number) => n + 1, 0);
  const sizes = useRef('');
  useLayoutEffect(() => {
    const now = [...inputs.current].map(([id, el]) => `${id}:${el.offsetWidth}x${el.offsetHeight}`).join(' ');
    if (now !== sizes.current) { sizes.current = now; remeasure(); }
  });

  useEffect(() => {
    if (!focus) return;
    const input = inputs.current.get(focus);
    if (!input || document.activeElement === input) return;
    input.focus();
    const end = input.value.length;
    if (drafts[focus] === undefined) input.select();
    else input.setSelectionRange(end, end);
  }, [focus, fields.length]);
  // A focused field not yet typed in shows the live value selected, so typing replaces it.
  useLayoutEffect(() => {
    const input = focus ? inputs.current.get(focus) : undefined;
    if (input && document.activeElement === input && drafts[focus!] === undefined) input.select();
  });

  if (!fields.length && !segments.length) return null;

  const position = (f: LayoutEntryField): readonly [number, number] => {
    if (!f.at) {
      const p = pointer ?? [0, 0];
      return [p[0] * scale + POINTER_OFFSET[0], p[1] * scale + POINTER_OFFSET[1]];
    }
    const at: readonly [number, number] = [f.at[0] * scale, f.at[1] * scale];
    if (!f.away) return at;
    const el = inputs.current.get(f.id);
    const size: readonly [number, number] = el?.offsetWidth ? [el.offsetWidth, el.offsetHeight] : FIELD_SIZE;
    return clearOf(at, [at[0] + f.away[0] * 10, at[1] + f.away[1] * 10], size);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, f: LayoutEntryField) => {
    if (e.key === 'Enter') { e.preventDefault(); props.onEnter(); }
    else if (e.key === 'Escape') { e.preventDefault(); props.onEscape(); }
    else if (e.key === 'Tab') { e.preventDefault(); props.onTab(f.id, e.shiftKey); }
  };

  return (
    <>
      {segments.length ? (
        <svg className="pf-layout-entry-dimensions" aria-hidden="true" viewBox={`0 0 ${pageSize[0]} ${pageSize[1]}`} preserveAspectRatio="none">
          {segments.map(([a, b], i) => <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />)}
        </svg>
      ) : null}
      {fields.map((f) => {
        const [x, y] = position(f);
        const draft = drafts[f.id];
        const editing = draft !== undefined;
        const cls = ['pf-entry', editing ? 'is-editing' : '', f.locked ? 'is-locked' : '', error === f.id ? 'is-error' : ''].filter(Boolean).join(' ');
        return (
          <input
            key={f.id}
            id={`pf-layout-entry-${f.id}`}
            ref={(el) => { if (el) inputs.current.set(f.id, el); else inputs.current.delete(f.id); }}
            className={cls}
            style={{ left: x, top: y, width: entryWidth(editing ? draft : f.value) }}
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={f.label}
            aria-invalid={error === f.id}
            title={f.label}
            value={editing ? draft : f.value}
            onChange={(e) => props.onDraft(f.id, e.target.value)}
            onKeyDown={(e) => onKeyDown(e, f)}
            onFocus={() => props.onFocus(f.id)}
            onBlur={() => props.onBlur(f.id)}
          />
        );
      })}
    </>
  );
}
