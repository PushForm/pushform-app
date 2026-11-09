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
