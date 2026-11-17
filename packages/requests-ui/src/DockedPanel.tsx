// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { useKeyIsolation } from './useKeyIsolation';

export interface DockedPanelProps {
  readonly label: string;
  readonly className?: string | undefined;
  /** False keeps the panel mounted but hidden, so a conversation survives hiding and showing within the session. */
  readonly open?: boolean | undefined;
  readonly children: ReactNode;
}

/**
 * Docked shell of AI Chat in an editor: an inline region that fills the host's
 * side dock, with no portal or fixed position. It shares the pop-down's key isolation, but neither Escape nor a
 * pointer press outside hides it: only its left menu bar icon does. Focus moves to the `[data-autofocus]` element when shown.
 */
export function DockedPanel({ label, className, open = true, children }: DockedPanelProps): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  useKeyIsolation(panel, { active: open });
  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ?? panel.current)?.focus();
  }, [open]);
  return <div ref={panel} className={`pf-fr-docked${className ? ` ${className}` : ''}`} role="region" aria-label={label} tabIndex={-1} hidden={!open}>
    {children}
  </div>;
}
