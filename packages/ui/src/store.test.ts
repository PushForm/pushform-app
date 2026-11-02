// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { useAppStore } from './store';

describe('useAppStore', () => {
  it('toggles panels one at a time', () => {
    const s = useAppStore.getState();
    s.togglePanel('materials');
    expect(useAppStore.getState().openPanel).toBe('materials');
    s.togglePanel('scenes');
    expect(useAppStore.getState().openPanel).toBe('scenes');
    s.togglePanel('scenes');
    expect(useAppStore.getState().openPanel).toBeNull();
  });

  it('tracks typed value fields', () => {
    const s = useAppStore.getState();
    s.setEntryDraft('width', '12');
    expect(useAppStore.getState().entryDrafts).toEqual({ width: '12' });
    expect(useAppStore.getState().entryFocus).toBe('width');
    s.clearEntryDraft('width');
    expect(useAppStore.getState().entryDrafts).toEqual({});
    s.setEntryDraft('height', '3');
    s.clearEntry();
    expect(useAppStore.getState()).toMatchObject({ entryDrafts: {}, entryFocus: null, entryError: null });
    const fields = [{ id: 'length', label: 'Length', kind: 'length' as const, value: '1 m' }];
    s.setStatus({ instructor: 'hi', vcbLabel: 'Length', vcbValue: '1 m', fields });
    expect(useAppStore.getState().vcbValue).toBe('1 m');
    expect(useAppStore.getState().entryFields).toEqual(fields);
  });
});
