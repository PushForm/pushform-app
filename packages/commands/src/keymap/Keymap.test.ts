// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { Keymap, chordFromEvent, normalizeChord } from './Keymap';
import type { KeyEventLike } from './Keymap';

const ev = (partial: Partial<KeyEventLike> & { key: string; code: string }): KeyEventLike => ({
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...partial,
});

describe('Keymap', () => {
  it('normalizes chords per platform', () => {
    expect(normalizeChord('Mod+Shift+Z', 'mac')).toBe('Meta+Shift+Z');
    expect(normalizeChord('Mod+Shift+Z', 'win')).toBe('Ctrl+Shift+Z');
    expect(normalizeChord('shift+space', 'win')).toBe('Shift+Space');
  });

  it('resolves events to commands', () => {
    const mac = new Keymap('mac');
    expect(mac.resolve(ev({ key: ' ', code: 'Space' }))).toBe('tool.select');
    expect(mac.resolve(ev({ key: 'z', code: 'KeyZ', metaKey: true }))).toBe('edit.undo');
    expect(mac.resolve(ev({ key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true }))).toBe('edit.redo');
    expect(mac.resolve(ev({ key: 'z', code: 'KeyZ', ctrlKey: true }))).toBeNull();
    expect(mac.resolve(ev({ key: 'p', code: 'KeyP' }))).toBe('tool.pushpull');
    expect(mac.resolve(ev({ key: 'Escape', code: 'Escape' }))).toBe('tool.cancel');

    const win = new Keymap('win');
    expect(win.resolve(ev({ key: 'z', code: 'KeyZ', ctrlKey: true }))).toBe('edit.undo');
    expect(win.resolve(ev({ key: 'y', code: 'KeyY', ctrlKey: true }))).toBe('edit.redo');
  });

  it('applies web overrides', () => {
    const web = new Keymap('mac', undefined, true);
    expect(web.resolve(ev({ key: 'W', code: 'KeyW', shiftKey: true }))).toBe('tool.zoomWindow');
    expect(web.resolve(ev({ key: 'E', code: 'KeyE', shiftKey: true, metaKey: true }))).toBe('camera.zoomExtents');
  });

  it('formats labels and supports rebinding', () => {
    const mac = new Keymap('mac');
    expect(mac.label('edit.undo')).toBe('⌘Z');
    mac.bind('Mod+U', 'edit.undo');
    expect(mac.bindingsFor('edit.undo')).toEqual(['Meta+Z', 'Meta+U']);
    mac.unbind('Mod+Z');
    expect(mac.label('edit.undo')).toBe('⌘U');
    expect(chordFromEvent(ev({ key: '1', code: 'Digit1', shiftKey: true }))).toBe('Shift+1');
  });
});
