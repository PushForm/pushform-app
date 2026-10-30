// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, type RefObject } from 'react';

export interface KeyIsolationOptions {
  /** Listen only while the panel is shown. */
  readonly active: boolean;
  /** Called for Escape pressed inside the panel. */
  readonly onEscape: () => void;
  /** The pop-down also takes an Escape pressed with nothing focused (focus on the page body). */
  readonly escapeWhenUnfocused?: boolean | undefined;
}

/**
 * Key isolation shared by the pop-down and docked chat: keys typed inside `container` stop at the window
 * capture phase so workspace shortcuts never see them, Enter inside a `data-submit-on-enter` textarea submits its
 * form (Shift+Enter inserts a newline), and Escape inside calls `onEscape`.
 */
export function useKeyIsolation(container: RefObject<HTMLElement | null>, { active, onEscape, escapeWhenUnfocused = false }: KeyIsolationOptions): void {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const inside = (node: EventTarget | null): boolean => node instanceof Node && !!container.current?.contains(node);
    const keydown = (event: KeyboardEvent): void => {
      const target = event.target;
      const within = inside(target);
      const unfocused = !(target instanceof Element) || target === document.body || target === document.documentElement;
      if (event.key === 'Escape' && (within || (escapeWhenUnfocused && unfocused))) {
        event.preventDefault(); event.stopImmediatePropagation(); escape.current(); return;
      }
      if (!within) return;
      event.stopImmediatePropagation();
      if (event.key === 'Enter' && !event.shiftKey && target instanceof HTMLTextAreaElement && target.dataset['submitOnEnter'] !== undefined && target.form) {
        event.preventDefault();
        if (typeof target.form.requestSubmit === 'function') target.form.requestSubmit();
        else target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    };
    const keyup = (event: KeyboardEvent): void => { if (inside(event.target)) event.stopImmediatePropagation(); };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
    };
  }, [container, active, escapeWhenUnfocused]);
}
