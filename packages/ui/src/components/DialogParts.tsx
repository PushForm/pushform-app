// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef } from 'react';
import type { JSX, KeyboardEvent, ReactNode } from 'react';

/** Building blocks shared by the shell's modal dialogs (Make Component, 3D Text, Rename). */

/** A modal dialog: Escape or a click outside closes it; the first field takes focus. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button');
    first?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="pf-dialog-backdrop" onMouseDown={onClose}>
      <div
        ref={ref}
        className="pf-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 className="pf-dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** A labelled dialog row. */
export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }): JSX.Element {
  return (
    <div className="pf-dialog-row">
      <label className="pf-dialog-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="pf-dialog-field">{children}</div>
    </div>
  );
}

/** A dialog checkbox with its label. */
export function Check({ id, label, checked, onChange, disabled }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }): JSX.Element {
  return (
    <label className="pf-dialog-check" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
