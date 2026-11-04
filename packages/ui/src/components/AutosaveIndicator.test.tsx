// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CloudAutosave } from '../cloudAutosave';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { AutosaveIndicator } from './AutosaveIndicator';

let session: DocumentSession;
afterEach(() => { cleanup(); session?.dispose(); vi.restoreAllMocks(); });
function setup(error?: string) {
  session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
  vi.spyOn(session, 'localSaveState').mockReturnValue('saved');
  const saveNow = vi.fn().mockResolvedValue(undefined), onSave = vi.fn();
  const saves = { automatic: false, subscribe: () => () => {}, getSnapshot: () => 0,
    state: () => error ? { status: 'error', error } : { status: 'waiting' }, saveNow } as unknown as CloudAutosave;
  render(<AutosaveIndicator session={session} autosave={saves} tab={session.active} onSave={onSave}/>);
  return { saveNow, onSave };
}
it('keeps a failed cloud save visible even when the local working copy is saved', () => {
  const f = setup('Connection interrupted');
  const label = screen.getByRole('status', { name: 'Cloud save status' }).textContent;
  expect(label).toContain('Saved on device'); expect(label).toContain('Cloud save failed');
  const panel = screen.getByRole('region', { name: 'Save details' });
  expect(within(panel).getByRole('alert').textContent).toBe('Connection interrupted');
  fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
  expect(f.saveNow).toHaveBeenCalledWith(session.active);
});
it('opens save details on demand and offers the explicit Save version action', () => {
  const f = setup();
  expect(screen.queryByRole('region', { name: 'Save details' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
  const panel = screen.getByRole('region', { name: 'Save details' });
  expect(within(panel).getByText('Not saved to cloud')).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Save version' }));
  expect(f.onSave).toHaveBeenCalledOnce();
  expect(screen.queryByRole('region', { name: 'Save details' })).toBeNull();
});
