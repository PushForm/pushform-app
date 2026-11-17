// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { containerAt, type EntityRef } from '@pushform/model';
import { useApp } from '../AppContext';
import { textScreenPoint, viewAxesOf } from '../engine/viewAxes';

/**
 * Edits a text in place: a box at the text's label holding its string, all selected. Enter or leaving the box
 * keeps the edit (`text.edit`, which erases text edited to nothing); Shift+Enter starts a new line; Escape keeps the
 * text as it was.
 */
export function TextEditor({ target, onClose }: { target: EntityRef; onClose: () => void }): JSX.Element | null {
  const app = useApp();
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  /** Where focus was last, and how to keep the edit, for focus that leaves the style row. */
  const lastFocus = useRef<Element | null>(null);
  const commit = useRef<() => void>(() => {});
  const [initial] = useState(() => {
    const state = app.document.doc.state;
    const [width, height] = [app.viewport.size.width, app.viewport.size.height];
    const at = textScreenPoint(state, target, viewAxesOf(app.viewport.camera.getState(), width, height), (p) => app.viewport.project(p));
    let text = '';
    try {
      text = target.kind === 'text' ? (containerAt(state, target.path).texts.get(target.id)?.text ?? '') : '';
    } catch {
      text = '';
    }
    return at ? { at, text, screen: containerAt(state, target.path).texts.get(target.id)?.kind === 'screen' } : null;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  useEffect(() => {
    if (!initial) onClose();
  }, [initial, onClose]);
  // While focus is in the style row the editor stays open; focus going anywhere else commits the text.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as Element | null;
      const fromBar = inStyleBar(lastFocus.current);
      lastFocus.current = el;
      if (el === ref.current || inStyleBar(el)) return;
      if (fromBar) commit.current();
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);
  if (!initial) return null;

  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = ref.current?.value ?? initial.text;
    if (keep && value !== initial.text) app.commands.tryExecute('text.edit', { ref: target, text: value });
    onClose();
  };
  commit.current = () => finish(true);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    }
  };
  const lines = Math.max(1, initial.text.split('\n').length);
  return (
    <textarea
      ref={ref}
      className={initial.screen ? 'pf-text-editor is-screen' : 'pf-text-editor'}
      aria-label="Edit text"
      defaultValue={initial.text}
      rows={lines}
      style={{ left: initial.at[0], top: initial.at[1] }}
      onKeyDown={onKeyDown}
      // the style row in the tool options bar keeps the editor open; anywhere else commits it
      onBlur={(e) => {
        if (!inStyleBar(e.relatedTarget)) finish(true);
      }}
    />
  );
}

/** Whether focus moved into the tool options bar, whose style row edits this text. */
function inStyleBar(el: EventTarget | null): boolean {
  return el instanceof Element && Boolean(el.closest('.pf-tob'));
}

