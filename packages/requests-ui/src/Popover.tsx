// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useKeyIsolation } from './useKeyIsolation';

export interface PopoverProps {
  readonly label: string;
  readonly className?: string | undefined;
  /** The icon button the pop-down hangs under; the panel is right-aligned to it and a click on it never counts as "outside". */
  readonly anchor?: HTMLElement | null | undefined;
  readonly onClose: () => void;
  /** False keeps the panel mounted but hidden, so a conversation survives closing and reopening within the session. */
  readonly open?: boolean | undefined;
  readonly children: ReactNode;
}

const GAP = 6, MARGIN = 8;

function placement(anchor: HTMLElement | null | undefined): CSSProperties {
  if (typeof window === 'undefined') return { top: 56, right: MARGIN };
  const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
  if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0)) return { top: 56, right: MARGIN };
  return { top: Math.round(rect.bottom + GAP), right: Math.max(MARGIN, Math.round(window.innerWidth - rect.right)) };
}

/**
 * Pop-down shell of AI Chat on Home: a non-modal panel anchored under its icon with no
 * backdrop. It closes on Escape, on a pointer press outside it (the anchor excluded, so the icon toggles), and
 * never on its own discards anything. Keys typed inside it never reach workspace shortcuts (useKeyIsolation).
 * Focus moves to the `[data-autofocus]` element on open and returns to the anchor on close.
 */
export function Popover({ label, className, anchor, onClose, open = true, children }: PopoverProps): JSX.Element {
  const panel = useRef<HTMLDivElement>(null), close = useRef(onClose);
  const [style, setStyle] = useState<CSSProperties>(() => placement(anchor));
  close.current = onClose;
  useKeyIsolation(panel, { active: open, onEscape: () => close.current(), escapeWhenUnfocused: true });
  useLayoutEffect(() => {
    if (!open) return;
    const update = (): void => setStyle(placement(anchor));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchor, open]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const target = panel.current?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ?? panel.current;
    target?.focus();
    const inside = (node: EventTarget | null): boolean => node instanceof Node && !!panel.current?.contains(node);
    const pointerdown = (event: PointerEvent | MouseEvent): void => {
      if (inside(event.target) || (anchor && event.target instanceof Node && anchor.contains(event.target))) return;
      close.current();
    };
    document.addEventListener('pointerdown', pointerdown, true);
    document.addEventListener('mousedown', pointerdown, true);
    return () => {
      document.removeEventListener('pointerdown', pointerdown, true);
      document.removeEventListener('mousedown', pointerdown, true);
      const back = anchor?.isConnected ? anchor : previous;
      if (back?.isConnected) back.focus();
    };
  }, [anchor, open]);
  return createPortal(<div ref={panel} className={`pf-fr-popover${className ? ` ${className}` : ''}`} role="dialog" aria-label={label} tabIndex={-1} style={style} hidden={!open}>
    {children}
  </div>, document.body);
}
