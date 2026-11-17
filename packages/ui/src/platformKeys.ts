// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Modifiers } from '@pushform/commands';

/**
 * Tools are written with Windows and Linux keys. On macOS, Cmd takes the place of Ctrl wherever a
 * tool uses it, tapped, held or with a click, and Alt is the Option key; the Control key is not a
 * tool modifier there, since Control-click opens the context menu.
 */
export function toolModifiers(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }, mac: boolean): Modifiers {
  return mac
    ? { shift: e.shiftKey, ctrl: e.metaKey, alt: e.altKey, meta: e.ctrlKey }
    : { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
}

/** The key name a tool sees: on macOS, Cmd is Ctrl and Control is not a tool key. */
export function toolKeyName(key: string, mac: boolean): string {
  if (!mac) return key;
  if (key === 'Meta') return 'Control';
  if (key === 'Control') return 'Meta';
  return key;
}

/** Key names in tool text (status hints, held-key tags) as the platform in use calls them. */
export function platformKeyText(text: string, mac: boolean): string {
  if (!mac) return text;
  return text.replace(/\bCtrl\b/g, 'Cmd').replace(/\bAlt\b/g, 'Option');
}
