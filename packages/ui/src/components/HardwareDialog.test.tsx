// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { installUiCommands } from '../engine/uiCommands';
import { useAppStore } from '../store';
import { DialogHost } from './MakeComponentDialog';
let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  useAppStore.getState().closeDialog();
});
function boot() {
  const a = createApp({
    demo: false,
    expose: false,
    kernel: new KernelClient(new InlineBackend()),
  });
  installUiCommands(a.commands);
  app = a;
  render(
    <AppContext.Provider value={a}>
      <DialogHost />
    </AppContext.Provider>,
  );
  return a;
}
it('shows real family defaults and only applicable plate and pocket controls', () => {
  const a = boot();
  act(() => void a.commands.execute('ui.hardware'));
  fireEvent.change(screen.getByLabelText('Shape'), { target: { value: 'backplate' } });
  expect(screen.getByLabelText('Wall / plate thickness')).toBeDefined();
  expect(screen.queryByLabelText('Mounting centers')).toBeNull();
  fireEvent.change(screen.getByLabelText('Shape'), { target: { value: 'ring' } });
  expect((screen.getByLabelText('Width') as HTMLInputElement).placeholder).toBe('50');
  fireEvent.change(screen.getByLabelText('Shape'), { target: { value: 'recessed-round' } });
  expect(screen.queryByLabelText('Length')).toBeNull();
});
it('rejects an invalid dimension without adding geometry', async () => {
  const a = boot();
  act(() => void a.commands.execute('ui.hardware'));
  const before = a.document.doc.state.definitions.size;
  fireEvent.change(screen.getByLabelText('Length'), { target: { value: '-2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate and place' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('finite'));
  expect(a.document.doc.state.definitions.size).toBe(before);
});
it('regenerates a selected round bar with a new grip without submitting stale derived width', async () => {
  const a = boot();
  await act(async () => {
    await a.commands.execute('hardware.create', {
      shape: 'bar-round',
      finish: 'chrome',
      point: [0, 0, 0],
    });
  });
  act(() => void a.commands.execute('ui.hardware'));
  fireEvent.change(screen.getByLabelText('Grip'), { target: { value: '12' } });
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate selected hardware' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const def = [...a.document.doc.state.definitions.values()].find((d) =>
    d.description.includes('"generator":"hardware"'),
  )!;
  expect(JSON.parse(def.description).grip).toBe(0.012);
  expect(JSON.parse(def.description).width).toBe(0.012);
});
it('regenerates wire mounting centers without submitting the old derived length', async () => {
  const a = boot();
  await act(async () => {
    await a.commands.execute('hardware.create', {
      shape: 'wire',
      finish: 'chrome',
      point: [0, 0, 0],
    });
  });
  act(() => void a.commands.execute('ui.hardware'));
  fireEvent.change(screen.getByLabelText('Mounting centers'), { target: { value: '140' } });
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate selected hardware' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const def = [...a.document.doc.state.definitions.values()].find((d) =>
    d.description.includes('"generator":"hardware"'),
  )!;
  expect(JSON.parse(def.description).spacing).toBe(0.14);
  expect(JSON.parse(def.description).length).toBeCloseTo(0.15, 9);
});
