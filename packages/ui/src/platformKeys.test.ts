// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { platformKeyText, toolKeyName, toolModifiers } from './platformKeys';

const ev = (p: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }>) => ({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...p });

it('on macOS, Cmd is a tool Ctrl, Option its Alt, and Control is not a tool modifier', () => {
  expect(toolModifiers(ev({ metaKey: true }), true)).toEqual({ shift: false, ctrl: true, alt: false, meta: false });
  expect(toolModifiers(ev({ ctrlKey: true }), true)).toEqual({ shift: false, ctrl: false, alt: false, meta: true });
  expect(toolModifiers(ev({ altKey: true, shiftKey: true }), true)).toEqual({ shift: true, ctrl: false, alt: true, meta: false });
  expect(toolKeyName('Meta', true)).toBe('Control');
  expect(toolKeyName('Control', true)).toBe('Meta');
  expect(toolKeyName('Alt', true)).toBe('Alt');
  expect(platformKeyText('Tap Ctrl to copy. Alt cycles. Ctrl+Shift removes.', true)).toBe('Tap Cmd to copy. Option cycles. Cmd+Shift removes.');
});

it('leaves Windows and Linux keys as they are', () => {
  expect(toolModifiers(ev({ ctrlKey: true }), false)).toEqual({ shift: false, ctrl: true, alt: false, meta: false });
  expect(toolKeyName('Control', false)).toBe('Control');
  expect(platformKeyText('Ctrl = adjacent', false)).toBe('Ctrl = adjacent');
});
