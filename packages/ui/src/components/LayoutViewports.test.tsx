// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { LayoutViewportCamera } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import type { CloudFilesApi } from '@pushform/cloud';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const camera: LayoutViewportCamera = { eye: [10, -10, 8], target: [0, 0, 1], up: [0, 0, 1], projection: 'perspective', fov: 35, scale: 1 };

function cloudAccess(session: DocumentSession) {
  const sha = 'a'.repeat(64);
  const head = { file: { id: 'doc-1', project_id: 'p', folder_id: null, name: 'House.pf', kind: 'model' as const, current_revision_id: 'rev-1', revision_number: 1, size_bytes: 3, updated_at: '' },
    revision: { id: 'rev-1', document_id: 'doc-1', blob_path: '', size_bytes: 3, sha256: sha, number: 1 } };
  const api = { head: vi.fn().mockResolvedValue(head),
    listProjects: vi.fn().mockResolvedValue([{ id: 'p2', name: 'Site' }, { id: 'p', name: 'Documents' }]),
    listFiles: vi.fn().mockResolvedValue([head.file, { ...head.file, id: 'doc-2', name: 'Plan.pfl', kind: 'layout' },
      { ...head.file, id: 'doc-3', name: 'Shed.pf', project_id: 'p2' }, { ...head.file, id: 'doc-4', name: 'Loose.pf', project_id: 'gone' }]) } as unknown as CloudFilesApi;
  return { api, owner: () => 'alice', session, saves: 0 };
}

function setup(withModel = true, cloud?: ReturnType<typeof cloudAccess> | 'cloud') {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  if (withModel) tab.doc.undoStack.transact('Import', draft => {
    draft.modelArchives = new Map([['archive', { format: 'sketchup-layout', archiveBase64: 'UEs=',
      models: new Map([['idModel', { internalTarget: 'ref/1850444548_Haus_55.skp', externalTarget: null }]]),
      viewports: new Map([['id60', { modelReferenceId: 'idModel', entityIds: [] }]]) }]]);
  });
  const access = cloud === 'cloud' ? cloudAccess(session) : cloud;
  const view = render(<LayoutWorkspace tab={tab} session={session} cloud={access} />);
  return { tab, pageId, view, canvas: screen.getByLabelText('Page 1 canvas'),
    dispose: () => { view.unmount(); session.dispose(); app.dispose(); } };
}

it('offers the Model View tool after Import only when the drawing has an embedded model', () => {
  const { dispose } = setup(false);
  const labels = within(screen.getByRole('navigation', { name: 'Layout tools' })).getAllByRole('button').map(button => button.getAttribute('aria-label'));
  expect(labels.slice(labels.indexOf('Import'), labels.indexOf('Import') + 3)).toEqual(['Import', 'Model View', 'Presentation mode']);
  const button = screen.getByRole('button', { name: 'Model View' }) as HTMLButtonElement;
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.disabled).toBe(false);
  fireEvent.mouseEnter(button);
  expect(screen.getByRole('tooltip').textContent).toMatch(/embedded SketchUp model/);
  fireEvent.mouseLeave(button);
  fireEvent.focus(button);
  expect(screen.getByRole('tooltip').textContent).toMatch(/embedded SketchUp model/);
  dispose();
  const withModel = setup();
  expect(screen.getByRole('button', { name: 'Model View' }).getAttribute('aria-disabled')).toBeNull();
  withModel.dispose();
});

it('shows the model view panel and navigates the camera as one undoable step per drag', () => {
  const { tab, pageId, canvas, dispose } = setup();
  let id = 0;
  act(() => { id = tab.commands.execute('layout.viewport.add', { pageId, first: [20, 20], second: [120, 80],
    source: { archiveId: 'archive', modelReferenceId: 'idModel' }, camera }) as number; });
  const view = () => tab.doc.state.pages.get(pageId)!.entities.get(id)!.image!.viewport!;
  fireEvent.doubleClick(canvas, { clientX: 210, clientY: 150 });
  const panel = screen.getByRole('region', { name: 'Model view' });
  expect(screen.queryByRole('combobox', { name: 'Shape layer' })).toBeNull();
  expect(within(panel).getByRole('button', { name: 'Done navigating' }).getAttribute('aria-pressed')).toBe('true');
  // Both the panel and the status bar explain the navigation gestures.
  expect(screen.getAllByText(/Drag to orbit, Shift\+drag or middle-drag to pan/)).toHaveLength(2);
  const versions = tab.doc.version;
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 210, clientY: 150 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 240, clientY: 150 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 270, clientY: 160 });
  // The drag previews without touching the document.
  expect(view().camera).toEqual(camera);
  expect(tab.doc.version).toBe(versions);
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 270, clientY: 160 });
  expect(view().camera.eye).not.toEqual(camera.eye);
  expect(view().camera.target).toEqual(camera.target);
  expect(view().scene).toBeNull();
  act(() => { tab.commands.execute('edit.undo'); });
  expect(view().camera).toEqual(camera);
  // Escape ends navigation; a click outside the view would too.
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(within(screen.getByRole('region', { name: 'Model view' })).getByRole('button', { name: 'Navigate view' })).toBeTruthy();
  dispose();
});

it('disables model-dependent controls and reports why when the model cannot be read', async () => {
  const { tab, pageId, canvas, dispose } = setup();
  act(() => { tab.commands.execute('layout.viewport.add', { pageId, first: [20, 20], second: [120, 80],
    source: { archiveId: 'archive', modelReferenceId: 'idModel' }, camera }); });
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 210, clientY: 150 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 210, clientY: 150 });
  const panel = screen.getByRole('region', { name: 'Model view' });
  // The fixture's archive holds no model, so what needs the model stays disabled and the panel says why.
  expect((within(panel).getByRole('button', { name: 'Top' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(panel).getByRole('combobox', { name: 'Scene' }) as HTMLSelectElement).disabled).toBe(true);
  expect(await within(panel).findByText(/The model cannot be rendered/)).toBeTruthy();
  dispose();
});

it('links a cloud model from the Model View tool and lists it with pin and edit controls', async () => {
  const { tab, dispose } = setup(false, 'cloud');
  const button = screen.getByRole('button', { name: 'Model View' });
  expect(button.getAttribute('aria-disabled')).toBeNull();
  fireEvent.click(button);
  const dialog = await screen.findByRole('dialog', { name: 'Choose a cloud model' });
  // Only model documents are offered, grouped by project in library order; models of an unlisted project come last.
  const sections = await within(dialog).findAllByRole('region');
  expect(sections.map(section => [section.getAttribute('aria-label'), within(section).getAllByRole('listitem').map(item => item.textContent)]))
    .toEqual([['Site', ['ShedRevision 1']], ['Documents', ['HouseRevision 1']], ['Other projects', ['LooseRevision 1']]]);
  fireEvent.click(within(dialog).getByRole('button', { name: /House/ }));
  await screen.findByRole('region', { name: 'Model references' });
  const reference = [...tab.doc.state.references.values()][0]!;
  expect(reference).toMatchObject({ displayName: 'House', target: { kind: 'cloud', documentId: 'doc-1', revisionNumber: 1, pinned: false } });
  expect(screen.getByRole('button', { name: 'Model View' }).getAttribute('aria-pressed')).toBe('true');
  const model = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
  expect([...model.options].map(option => option.textContent)).toEqual(['House', 'Choose cloud model…']);
  const references = screen.getByRole('region', { name: 'Model references' });
  expect(within(references).getByText(/Cloud model, revision 1/).textContent).toMatch(/Current/);
  fireEvent.click(within(references).getByRole('button', { name: 'Pin' }));
  expect((tab.doc.state.references.get(reference.id)!.target as { pinned: boolean }).pinned).toBe(true);
  expect(within(references).getByRole('button', { name: 'Unpin' })).toBeTruthy();
  expect(within(references).getByRole('button', { name: 'Edit model' })).toBeTruthy();
  dispose();
});

it('offers to make an embedded model editable only with cloud access', () => {
  const { dispose } = setup(true);
  const references = screen.getByRole('region', { name: 'Model references' });
  expect(within(references).getByText(/Embedded SketchUp model/)).toBeTruthy();
  expect((within(references).getByRole('button', { name: 'Edit model' }) as HTMLButtonElement).disabled).toBe(true);
  dispose();
  const withCloud = setup(true, 'cloud');
  expect((within(screen.getByRole('region', { name: 'Model references' })).getByRole('button', { name: 'Edit model' }) as HTMLButtonElement).disabled).toBe(false);
  withCloud.dispose();
});
