// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CloudFilesApi } from '@pushform/cloud';
import { createApp } from '../bootstrap';
import { CloudAutosave } from '../cloudAutosave';
import { DocumentSession } from '../session';
import { TopBar } from './TopBar';

let session: DocumentSession, saves: CloudAutosave;
afterEach(() => { cleanup(); saves?.dispose(); session?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
  const tab = session.active; if (tab.type !== 'model') throw new Error('Expected model');
  tab.app.document.edit('Edit model', draft => { draft.definitions.get(draft.rootDefinitionId)!.name = 'Changed'; });
  session.newModel({ name: 'Other' }); session.activate(tab.id);
  let sequence = 0;
  const api: CloudFilesApi = {
    listProjects: vi.fn().mockResolvedValue([{ id: 'documents', name: 'Documents' }]), createProject: vi.fn(),
    listFiles: vi.fn(), listFolders: vi.fn(), createFolder: vi.fn(), open: vi.fn(), head: vi.fn(), openRevision: vi.fn(), recordImport: vi.fn(),
    save: vi.fn().mockImplementation(async input => {
      sequence++;
      return { file: { id: input.fileId ?? 'file', project_id: input.projectId, folder_id: null, name: input.name, kind: input.kind,
        current_revision_id: 'revision-' + sequence, revision_number: sequence, size_bytes: input.bytes.length, updated_at: '' },
      revision: { id: 'revision-' + sequence, document_id: input.fileId ?? 'file', blob_path: '', size_bytes: input.bytes.length, sha256: '', number: sequence } };
    }),
  };
  saves = new CloudAutosave(api, session, () => 'owner', () => {}, 100, false);
  render(<TopBar session={session} cloudFiles={api} autosave={saves}/>);
  const close = () => fireEvent.click(screen.getByRole('button', { name: 'Close Untitled' }));
  return { tab, api, close };
}
it('shows a cloud save error inside the close dialog and closes only after a successful retry', async () => {
  const f = setup(); vi.mocked(f.api.save).mockRejectedValueOnce(new Error('Connection interrupted'));
  f.close();
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save' }));
  const dialog = screen.getByRole('dialog', { name: 'Unsaved changes' });
  expect((await within(dialog).findByRole('alert')).textContent).toContain('Connection interrupted');
  expect(session.tabs).toContain(f.tab);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry save' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).toBeNull());
  expect(f.api.save).toHaveBeenCalledTimes(2); expect(session.tabs).not.toContain(f.tab);
});
it('shows saving progress, prevents duplicate saves and retains edits made after the saved snapshot', async () => {
  const f = setup(), original = f.api.save;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const save = vi.fn<CloudFilesApi['save']>(async input => { await pending; return original(input); });
  f.api.save = save;
  f.close();
  const dialog = screen.getByRole('dialog', { name: 'Unsaved changes' });
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Save' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(within(dialog).getByRole('status').textContent).toContain('Saving');
  expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Saving…' }).disabled).toBe(true);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBe(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Saving…' }));
  act(() => f.tab.app.document.edit('Later edit', draft => { draft.definitions.get(draft.rootDefinitionId)!.name = 'Newer changes'; }));
  await act(async () => { release(); });
  expect((await within(dialog).findByRole('alert')).textContent).toContain('New changes');
  expect(save).toHaveBeenCalledOnce(); expect(session.tabs).toContain(f.tab);
});
it('captures Ctrl+S and Cmd+S from text fields, prevents Save Page and avoids duplicate modal saves', async () => {
  const f = setup(), input = screen.getByRole('combobox', { name: 'Search tools and commands' });
  fireEvent.focus(input);
  const chord = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  act(() => { input.dispatchEvent(chord); });
  expect(chord.defaultPrevented).toBe(true);
  expect(screen.getByRole('dialog', { name: 'Save version' })).toBeTruthy();
  const again = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
  act(() => { window.dispatchEvent(again); });
  expect(again.defaultPrevented).toBe(true); expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(f.api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.keyDown(window, { key: 's', metaKey: true, repeat: true });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.keyDown(window, { key: 's', metaKey: true });
  expect(screen.getByRole('dialog', { name: 'Save version' })).toBeTruthy();
});
