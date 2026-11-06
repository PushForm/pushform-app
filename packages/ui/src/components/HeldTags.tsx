// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useReducer } from 'react';
import type { JSX, RefObject } from 'react';
import { useApp } from '../AppContext';
import { useAppStore } from '../store';

/** Offset of the tags from the pointer: below the cursor hint and the pointer's value field. */
const OFFSET: readonly [number, number] = [14, 46];

/**
 * Tags naming the held keys and keyed modes in force, such as "On red axis" or
 * "Inference off · Alt", drawn just below the pointer and never above the band at `minTop`.
 */
export function HeldTags({ pointer, minTop }: { pointer: RefObject<readonly [number, number]>; minTop: RefObject<number> }): JSX.Element | null {
  const app = useApp();
  const held = useAppStore((s) => s.toolHeld);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => app.viewport.events.on('render', rerender), [app]);
  if (!held.length) return null;
  const p = pointer.current ?? [0, 0];
  const top = Math.max(p[1] + OFFSET[1], minTop.current ?? 0);
  return (
    <div className="pf-held-tags" aria-live="polite" aria-label="Held keys" style={{ left: p[0] + OFFSET[0], top }}>
      {held.map((t) => <span key={t} className="pf-held-tag">{t}</span>)}
    </div>
  );
}
