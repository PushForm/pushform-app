// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { modelClipboard, type CameraState } from '@pushform/commands';
import { viewportPaperPoint } from '@pushform/layout';
import type { CloudFilesApi } from '@pushform/cloud';
import type { EntityRef } from '@pushform/model';
import { createApp } from './bootstrap';
import { DocumentSession } from './session';
import { decodeModelClipboard, encodeModelClipboard, MODEL_CLIPBOARD_TYPE, useModelClipboard } from './modelClipboard';
import { croppedViewportCamera } from './components/layoutViewportCameras';
import { LayoutWorkspace } from './components/LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); modelClipboard.set(null); });

function clipboard(values: Record<string, string> = {}) {
  return { values, getData: (type: string) => values[type] ?? '', setData: (type: string, value: string) => { values[type] = value; }, files: [], items: [] };
}

function modelTab(session: DocumentSession, identity?: string) {
  const tab = session.newModel();
  if (identity) tab.identity = identity;
  return tab;
}

const ISO: CameraState = { eye: [10, -10, 8], target: [0, 0, 1], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 10 };

it('round-trips a copy through the system clipboard format', () => {
  const app = createApp({ demo: false, expose: false }), other = createApp({ demo: false, expose: false });
  const box = app.commands.execute('model.addBox', { min: [1, 1, 0], max: [2, 2, 1] }) as number;
  app.commands.execute('selection.set', { refs: [{ kind: 'body', path: [], id: box }] });
  app.commands.execute('edit.copy');
  const text = encodeModelClipboard(modelClipboard.current!);
  modelClipboard.set(decodeModelClipboard(text));
  const [ref] = other.commands.execute('edit.pasteInPlace') as EntityRef[];
  const pasted = other.document.doc.rootDefinition.entities.bodies.get(ref!.id)!;
  expect(Math.min(...Array.from(pasted.mesh.verts).filter((_, i) => i % 3 === 0))).toBe(1);
  app.dispose(); other.dispose();
});

it('copies on the copy event, writes the clipboard type and pastes another window\'s copy with the cursor', () => {
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = modelTab(session, 'cloud:alice:p:doc-1:rev-1');
  const box = tab.app.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
  tab.app.commands.execute('selection.set', { refs: [{ kind: 'body', path: [], id: box }] });
  const hook = renderHook(() => useModelClipboard(tab.app, tab, true));
  const data = clipboard();
  fireEvent.copy(window, { clipboardData: data });
  const json = JSON.parse(data.values[MODEL_CLIPBOARD_TYPE]!) as { source: unknown; extent: unknown[] };
  expect(json.source).toEqual({ documentId: 'doc-1', name: tab.name });
  expect(json.extent).toHaveLength(8);

  // Another window's copy: a different id on the system clipboard replaces this window's copy.
  const foreign = JSON.stringify({ ...JSON.parse(data.values[MODEL_CLIPBOARD_TYPE]!), id: 'other-window' });
  fireEvent.paste(window, { clipboardData: clipboard({ [MODEL_CLIPBOARD_TYPE]: foreign }) });
  expect(modelClipboard.current?.id).toBe('other-window');
  expect(tab.app.toolManager.activeToolId).toBe('paste');
  hook.unmount();
  session.dispose(); app.dispose();
});

it('leaves text paste alone when the system clipboard holds something newer than this window\'s copy', () => {
  const app = createApp({ demo: false, expose: false });
  const box = app.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
  app.commands.execute('selection.set', { refs: [{ kind: 'body', path: [], id: box }] });
  const hook = renderHook(() => useModelClipboard(app, null, true));
  fireEvent.copy(window, { clipboardData: clipboard() });
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'later text' }) });
  expect(app.toolManager.activeToolId).not.toBe('paste');
  // a copy made from command search never reached the system clipboard, so it pastes
  app.commands.execute('edit.copy');
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'older text' }) });
  expect(app.toolManager.activeToolId).toBe('paste');
  hook.unmount();
  app.dispose();
});

it('crops a view to the copied extent, keeping the eye and direction', () => {
  const extent: [number, number, number][] = [];
  for (let i = 0; i < 8; i++) extent.push([i & 1 ? 1 : -1, i & 2 ? 2 : 0, i & 4 ? 1 : 0]);
  for (const camera of [ISO, { ...ISO, projection: 'parallel' as const }]) {
    const { camera: view, width, height } = croppedViewportCamera(camera, extent, 150, 100, 0);
    expect(view.eye).toEqual(camera.eye);
    expect(view.target).toEqual(camera.target);
    expect(width <= 150 + 1e-9 && height <= 100 + 1e-9).toBe(true);
    expect(Math.max(width / 150, height / 100)).toBeCloseTo(1, 9);
    const frame: [number, number][] = [[0, 0], [width, 0], [width, height], [0, height]];
    const paper = extent.map(p => viewportPaperPoint(frame, view, p)!);
    expect(Math.min(...paper.map(p => p[0]))).toBeCloseTo(0, 6);
    expect(Math.max(...paper.map(p => p[0]))).toBeCloseTo(width, 6);
    expect(Math.min(...paper.map(p => p[1]))).toBeCloseTo(0, 6);
    expect(Math.max(...paper.map(p => p[1]))).toBeCloseTo(height, 6);
  }
});

function layoutSetup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const sha = 'a'.repeat(64);
  const head = { file: { id: 'doc-1', project_id: 'p', folder_id: null, name: 'House.pf', kind: 'model' as const, current_revision_id: 'rev-3', revision_number: 3, size_bytes: 3, updated_at: '' },
    revision: { id: 'rev-3', document_id: 'doc-1', blob_path: '', size_bytes: 3, sha256: sha, number: 3 } };
  const api = { head: vi.fn().mockResolvedValue(head), listProjects: vi.fn().mockResolvedValue([]), listFiles: vi.fn().mockResolvedValue([]) } as unknown as CloudFilesApi;
  const tab = session.newLayout(), pageId = tab.activePageId;
  render(<LayoutWorkspace tab={tab} session={session} cloud={{ api, owner: () => 'alice', session, saves: 0 } as never} />);
  return { app, session, tab, pageId, api, dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

it('pastes a Modeling copy into Layout as a selected, cropped view of its cloud model', async () => {
  const { app, tab, pageId, dispose } = layoutSetup();
  const model = createApp({ demo: false, expose: false });
  model.commands.ctx.services.set('modelSource', () => ({ documentId: 'doc-1', name: 'House.pf' }));
  const box = model.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
  model.commands.execute('selection.set', { refs: [{ kind: 'body', path: [], id: box }] });
  model.commands.execute('edit.copy');
  fireEvent.paste(window, { clipboardData: clipboard({ [MODEL_CLIPBOARD_TYPE]: encodeModelClipboard(modelClipboard.current!) }) });
  await waitFor(() => expect([...tab.doc.state.pages.get(pageId)!.entities.values()]).toHaveLength(1));
  const entity = [...tab.doc.state.pages.get(pageId)!.entities.values()][0]!;
  const viewport = entity.image!.viewport!;
  const reference = tab.doc.state.references.get((viewport.source as { referenceId: number }).referenceId)!;
  expect(reference.target).toMatchObject({ kind: 'cloud', documentId: 'doc-1', revisionId: 'rev-3' });
  expect(reference.displayName).toBe('House');
  const [w, h] = tab.doc.state.pages.get(pageId)!.size;
  const xs = entity.points.map(p => p[0]), ys = entity.points.map(p => p[1]);
  expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(w / 2, 6);
  expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(h / 2, 6);
  expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(w / 2 + 1e-6);
  expect(viewport.camera.shift).toBeDefined();
  // the view and its reference are one undoable step
  act(() => { tab.commands.execute('edit.undo'); });
  expect(tab.doc.state.pages.get(pageId)!.entities.size).toBe(0);
  expect(tab.doc.state.references.size).toBe(0);
  model.dispose();
  void app;
  dispose();
});

it('asks to save the model first when the copy has no cloud document', async () => {
  const { tab, pageId, dispose } = layoutSetup();
  const model = createApp({ demo: false, expose: false });
  const box = model.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
  model.commands.execute('selection.set', { refs: [{ kind: 'body', path: [], id: box }] });
  model.commands.execute('edit.copy');
  fireEvent.paste(window, { clipboardData: clipboard({ [MODEL_CLIPBOARD_TYPE]: encodeModelClipboard(modelClipboard.current!) }) });
  await waitFor(() => expect(screen.getByText(/Save the model to the cloud/)).toBeTruthy());
  expect(tab.doc.state.pages.get(pageId)!.entities.size).toBe(0);
  model.dispose();
  dispose();
});
