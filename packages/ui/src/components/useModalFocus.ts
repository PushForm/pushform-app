// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, type RefObject } from 'react';

/**
 * Modal focus for small dialogs: the app behind goes inert, the first button takes focus, Tab stays among
 * the dialog's enabled buttons and links, Escape closes, workspace shortcuts are blocked while open, and focus returns afterwards.
 */
export function useModalFocus(dialog: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app'), wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const keydown = (event: KeyboardEvent): void => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') {
        event.preventDefault();
        const targets = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')];
        const index = targets.indexOf(document.activeElement as HTMLElement);
        const next = index < 0 ? (event.shiftKey ? targets.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
        targets[next]?.focus();
      }
    };
    const keyup = (event: KeyboardEvent): void => event.stopImmediatePropagation();
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
      if (app) app.inert = wasInert;
      if (previous?.isConnected) previous.focus();
    };
  }, [dialog]);
}
