// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fireEvent } from '@testing-library/react';

/** Start typing on the Layout page, as a user does, and return the value field that opened with focus. */
export function openLayoutEntry(value: string, first = '1'): HTMLInputElement {
  fireEvent.keyDown(window, { key: first });
  const input = document.activeElement;
  if (!(input instanceof HTMLInputElement) || !input.classList.contains('pf-entry')) throw new Error('Typing did not open a value field.');
  fireEvent.change(input, { target: { value } });
  return input;
}

/** Type `value` into the first value field on the Layout page and press Enter. */
export function enterLayoutValue(value: string, enter: KeyboardEventInit = {}): void {
  const input = openLayoutEntry(value);
  fireEvent.keyDown(input, { key: 'Enter', ...enter });
}

/** The value field labelled `label`. */
export function layoutEntryField(label: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input.pf-entry[aria-label="${label}"]`);
  if (!input) throw new Error(`No ${label} value field.`);
  return input;
}
