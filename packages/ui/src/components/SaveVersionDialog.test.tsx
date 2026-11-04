// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import type { CloudAutosave } from '../cloudAutosave';
import type { CloudFilesApi } from '@pushform/cloud';
import { SaveVersionDialog } from './SaveVersionDialog';

let session: DocumentSession;
afterEach(() => { cleanup(); session?.dispose(); });
function setup(fail = false) {
  session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
  const tab = session.active; if (tab.type !== 'model') throw new Error('Expected model');
  const snapshot = { bytes: new Uint8Array([4,5,6]), file: { id: 'file', revision_number: 1 }, revision: { id: 'revision' } };
  const files = { head: vi.fn().mockResolvedValue({ file: { revision_number: 1 } }), openRevision: vi.fn().mockResolvedValue(snapshot) } as unknown as CloudFilesApi;
  const saveNow = vi.fn(async () => { if (fail) throw new Error('Connection interrupted'); session.markModelSaved(tab.id, tab.name, 'cloud:owner:project:file:revision'); });
  const onClose = vi.fn(), onShare = vi.fn();
  render(<SaveVersionDialog tab={tab} session={session} files={files} saves={{ saveNow } as unknown as CloudAutosave} onClose={onClose} onShare={onShare} />);
  return { files, saveNow, onClose, onShare, snapshot };
}
it('starts sharing unchecked, saves private change notes, and only hands the exact saved revision to publishing after success', async () => {
  const f = setup();
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Reinforced legs' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save & continue to publishing' }));
  await waitFor(() => expect(f.onShare).toHaveBeenCalledWith(f.snapshot));
  expect(f.saveNow).toHaveBeenCalledWith(session.active, 'Reinforced legs');
  expect(f.files.openRevision).toHaveBeenCalledWith('revision');
});
it('keeps the dialog and local document on save failure and never starts publishing', async () => {
  const f = setup(true); fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save & continue to publishing' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Connection interrupted');
  expect(f.onShare).not.toHaveBeenCalled(); expect(f.onClose).not.toHaveBeenCalled();
  expect(session.tabs).toHaveLength(1);
});
