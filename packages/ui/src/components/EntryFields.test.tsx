// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_UNITS, type UnitSettings } from '@pushform/core';
import type { EntryField, VcbValue } from '@pushform/commands';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { useAppStore } from '../store';
import { beginEntry, EntryFields } from './EntryFields';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  useAppStore.getState().clearEntry();
  useAppStore.getState().setStatus({ instructor: '', vcbLabel: '' });
});

const FIELDS: EntryField[] = [
  { id: 'width', label: 'Width', kind: 'length', value: '1 m', at: [0, 0, 0] },
  { id: 'height', label: 'Height', kind: 'length', value: '2 m', at: [1, 0, 0] },
];

function mount(units: Partial<UnitSettings> = {}, fields: EntryField[] = FIELDS): AppInstance {
  cleanup();
  app?.dispose();
  const a = (app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) }));
  a.document.edit('Units', (draft) => { draft.meta.units = { ...DEFAULT_UNITS, ...units }; });
  render(<AppContext.Provider value={a}><EntryFields pointer={{ current: [10, 10] }} /></AppContext.Provider>);
  act(() => useAppStore.getState().setStatus({ instructor: '', vcbLabel: 'Length', fields }));
  return a;
}

/** Types `text` into the field opened by typing when the tool shows none, and returns what the tool receives. */
function submit(text: string, units: Partial<UnitSettings>): VcbValue | undefined {
  const a = mount(units, []);
  const received = vi.spyOn(a.toolManager, 'onVcb').mockImplementation(() => {});
  act(() => beginEntry(text));
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Length' }), { key: 'Enter' });
  return received.mock.calls[0]?.[0];
}
const meters = (v: VcbValue | undefined): number => (v?.kind === 'length' ? v.meters : NaN);

it('reads a bare number in the model length unit and lets a typed unit override it', () => {
  expect(meters(submit('24', { format: 'architectural', lengthUnit: 'in' }))).toBeCloseTo(0.6096, 9);
  expect(meters(submit('24', { format: 'decimal', lengthUnit: 'mm' }))).toBeCloseTo(0.024, 9);
  expect(meters(submit('10', { format: 'engineering', lengthUnit: 'ft' }))).toBeCloseTo(3.048, 9);
  expect(meters(submit(`3'6"`, { format: 'decimal', lengthUnit: 'mm' }))).toBeCloseTo(1.0668, 9);
  expect(submit('10,20', { format: 'decimal', lengthUnit: 'cm' })).toMatchObject({ kind: 'list', values: [{ meters: 0.1 }, { meters: 0.2 }] });
});

it('shows the tool fields with live values; typing starts the first, Tab locks it and moves on, Enter applies', () => {
  const a = mount({ format: 'decimal', lengthUnit: 'mm' });
  const width = screen.getByRole('textbox', { name: 'Width' }) as HTMLInputElement;
  const height = screen.getByRole('textbox', { name: 'Height' }) as HTMLInputElement;
  expect(width.value).toBe('1 m');
  expect(height.value).toBe('2 m');
  const lock = vi.spyOn(a.toolManager, 'lockEntry');
  const apply = vi.spyOn(a.toolManager, 'onEntry').mockImplementation(() => {});
  act(() => beginEntry('3'));
  expect(width.value).toBe('3');
  expect(document.activeElement).toBe(width);
  fireEvent.keyDown(width, { key: 'Tab' });
  expect(lock).toHaveBeenCalledWith('width', expect.objectContaining({ kind: 'length', meters: 0.003 }));
  expect(document.activeElement).toBe(height);
  fireEvent.change(height, { target: { value: '40' } });
  fireEvent.keyDown(height, { key: 'Enter' });
  expect(apply).toHaveBeenCalledWith({ height: expect.objectContaining({ meters: 0.04 }) });
  expect(useAppStore.getState().entryDrafts).toEqual({});
});

it('marks a field it cannot read and applies nothing; Escape cancels the tool', () => {
  const a = mount();
  const apply = vi.spyOn(a.toolManager, 'onEntry');
  const cancel = vi.spyOn(a.toolManager, 'cancel');
  act(() => beginEntry('x'));
  const width = screen.getByRole('textbox', { name: 'Width' });
  fireEvent.keyDown(width, { key: 'Enter' });
  expect(apply).not.toHaveBeenCalled();
  expect(width.className).toContain('is-error');
  fireEvent.keyDown(width, { key: 'Escape' });
  expect(cancel).toHaveBeenCalled();
  expect(useAppStore.getState().entryDrafts).toEqual({});
});

it('sends values other than lengths and angles to the tool as typed', () => {
  const a = mount();
  const vcb = vi.spyOn(a.toolManager, 'onVcb').mockImplementation(() => {});
  act(() => beginEntry('8s'));
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Width' }), { key: 'Enter' });
  expect(vcb).toHaveBeenCalledWith({ kind: 'segments', count: 8 });
});
