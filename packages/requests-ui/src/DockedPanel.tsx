// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { useKeyIsolation } from './useKeyIsolation';

export interface DockedPanelProps {
  readonly label: string;
  readonly className?: string | undefined;
  /** The left menu bar icon that toggles the panel; focus returns to it when Escape hides the panel. */
  readonly anchor?: HTMLElement | null | undefined;
  readonly onClose: () => void;
  /** False keeps the panel mounted but hidden, so a conversation survives hiding and showing within the session. */
  readonly open?: boolean | undefined;
  readonly children: ReactNode;
}

/**
 * Docked shell of AI Chat in an editor: an inline region that fills the host's
 * side dock, with no portal or fixed position. It shares the pop-down's key isolation and Escape, but a pointer press
 * outside never hides it, so it stays open while the user works in the editor. Focus moves to the `[data-autofocus]`
 * element when shown and returns to the anchor when Escape hides it.
 */
export function DockedPanel({ label, className, anchor, onClose, open = true, children }: DockedPanelProps): JSX.Element {
  const panel = useRef<HTMLDivElement>(null), close = useRef(onClose), back = useRef(anchor);
  close.current = onClose; back.current = anchor;
  useKeyIsolation(panel, { active: open, onEscape: () => {
    close.current();
    if (back.current?.isConnected) back.current.focus();
  } });
  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ?? panel.current)?.focus();
  }, [open]);
  return <div ref={panel} className={`pf-fr-docked${className ? ` ${className}` : ''}`} role="region" aria-label={label} tabIndex={-1} hidden={!open}>
    {children}
  </div>;
}
