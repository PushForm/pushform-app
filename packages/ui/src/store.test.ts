// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { useAppStore } from './store';

describe('useAppStore', () => {
  it('toggles panels one at a time', () => {
    const s = useAppStore.getState();
    s.togglePanel('materials');
    expect(useAppStore.getState().openPanel).toBe('materials');
    s.togglePanel('tags');
    expect(useAppStore.getState().openPanel).toBe('tags');
    s.togglePanel('tags');
    expect(useAppStore.getState().openPanel).toBeNull();
  });

  it('tracks VCB editing state', () => {
    const s = useAppStore.getState();
    s.setVcbInput('12', true);
    expect(useAppStore.getState().vcbEditing).toBe(true);
    s.setVcbInput('', false);
    expect(useAppStore.getState().vcbEditing).toBe(false);
    s.setStatus({ instructor: 'hi', vcbLabel: 'Length', vcbValue: '1 m' });
    expect(useAppStore.getState().vcbValue).toBe('1 m');
  });
});
