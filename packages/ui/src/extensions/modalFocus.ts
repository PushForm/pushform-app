// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { KeyboardEvent } from 'react';

/** Focus handling shared by the extension window and extension dialogs, which are both modal. */

const CANDIDATES = 'button, input, select, textarea, a[href], [tabindex]';

/** The controls in `within` that Tab could reach, in document order: enabled, and not taken out of the Tab order. */
export function focusable(within: Element | null | undefined): HTMLElement[] {
  return [...(within?.querySelectorAll<HTMLElement>(CANDIDATES) ?? [])]
    .filter((el) => el.tabIndex >= 0 && !(el as HTMLElement & { disabled?: boolean }).disabled);
}

/** The first control in `within` that Tab would reach. */
export function firstFocusable(within: Element | null | undefined): HTMLElement | undefined {
  return focusable(within)[0];
}

/**
 * Moves focus for a Tab or Shift+Tab inside `container`, in order and wrapping, whatever the browser's own Tab order
 * would skip. Returns whether the key was a Tab it handled.
 */
export function trapTab(e: KeyboardEvent, container: HTMLElement | null): boolean {
  if (e.key !== 'Tab' || !container) return false;
  e.preventDefault();
  const controls = focusable(container).filter((el) => el.getClientRects().length > 0 || el === document.activeElement);
  if (!controls.length) return true;
  const at = controls.indexOf(document.activeElement as HTMLElement);
  const next = at < 0 ? (e.shiftKey ? controls.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + controls.length) % controls.length;
  controls[next]!.focus();
  return true;
}
