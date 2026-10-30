// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_UNITS, type UnitSettings } from '@pushform/core';
import type { VcbValue } from '@pushform/commands';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { useAppStore } from '../store';
import { MeasurementsBox } from './MeasurementsBox';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  useAppStore.getState().setVcbInput('', false);
});

/** Types `text` into the Measurements box of a model with `units` and returns what the active tool receives. */
function submit(text: string, units: Partial<UnitSettings>): VcbValue | undefined {
  cleanup();
  app?.dispose();
  const a = (app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) }));
  a.document.edit('Units', (draft) => { draft.meta.units = { ...DEFAULT_UNITS, ...units }; });
  const received = vi.spyOn(a.toolManager, 'onVcb').mockImplementation(() => {});
  render(<AppContext.Provider value={a}><MeasurementsBox /></AppContext.Provider>);
  const input = screen.getByRole('textbox', { name: 'Measurements' });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
  return received.mock.calls[0]?.[0];
}
const meters = (v: VcbValue | undefined): number => (v?.kind === 'length' ? v.meters : NaN);

it('reads a bare number in the model length unit and lets a typed unit override it', () => {
  expect(meters(submit('24', { format: 'architectural', lengthUnit: 'in' }))).toBeCloseTo(0.6096, 9);
  expect(meters(submit('24', { format: 'decimal', lengthUnit: 'mm' }))).toBeCloseTo(0.024, 9);
  expect(meters(submit('24', { format: 'decimal', lengthUnit: 'm' }))).toBeCloseTo(24, 9);
  expect(meters(submit('10', { format: 'engineering', lengthUnit: 'ft' }))).toBeCloseTo(3.048, 9);
  expect(meters(submit('2.5m', { format: 'architectural', lengthUnit: 'in' }))).toBeCloseTo(2.5, 9);
  expect(meters(submit(`3'6"`, { format: 'decimal', lengthUnit: 'mm' }))).toBeCloseTo(1.0668, 9);
  expect(submit('10,20', { format: 'decimal', lengthUnit: 'cm' })).toMatchObject({ kind: 'list', values: [{ meters: 0.1 }, { meters: 0.2 }] });
});
