// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_TOOLS } from '@pushform/extension-protocol';
import { LayoutDocumentApi, runLayoutTool } from '@pushform/extensions';
import { createApp } from './bootstrap';
import { documentToolsFor } from './documentTools';
import { DocumentSession } from './session';

let session: DocumentSession | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  session?.dispose();
  session = null;
});
const open = (): DocumentSession => (session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null));

describe('documentToolsFor', () => {
  it('offers the model API for a model tab and the Layout API for a Layout tab', () => {
    const s = open();
    expect(s.active.type).toBe('model');
    expect(documentToolsFor(s, s.active)?.document).toEqual({ type: 'model', apiVersion: 1, edit: 1 });
    expect(documentToolsFor(s, s.newLayout())?.document).toEqual({ type: 'layout', apiVersion: 1 });
  });

  it('edits the model tab it was bound to as one undo entry, shows progress and stops after a tab switch', async () => {
    const s = open();
    const tab = s.active;
    if (tab.type !== 'model') throw new Error('expected a model tab');
    const tools = documentToolsFor(s, tab)!;
    const bodyId = tab.app.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    const revision = JSON.parse((await tools.run({ id: 'a', name: 'model_get_document', input: {} })).content).revision as number;
    const call = { id: 'b', name: 'model_apply_operations', input: { expectedRevision: revision, label: 'Group it', operations: [{ op: 'make_group', refs: [{ kind: 'body', id: bodyId }] }] } };
    expect(tools.progress?.(call)).toBe('Applying the change…');
    expect(tools.progress?.({ id: 'a', name: 'model_get_document', input: {} })).toBeUndefined();
    const outcome = await tools.run(call);
    expect(outcome.isError).toBe(false);
    expect(outcome.notice).toBe('Changed the document: Group it. Undo reverts it.');
    const root = () => tab.app.document.doc.rootDefinition.entities;
    expect(root().instances.size).toBe(1);
    expect(tab.app.document.undoStack.peek()?.label).toBe('AI Chat: Group it');
    expect(tab.app.commands.execute('edit.undo')).toBe(true);
    expect(root().instances.size).toBe(0);
    s.newLayout();
    const switched = await tools.run({ ...call, input: { ...call.input, expectedRevision: tab.app.document.doc.version } });
    expect(JSON.parse(switched.content).error.code).toBe('unavailable');
    expect(root().instances.size).toBe(0);
  });

  it('makes all of one message\'s batches one undo step, with one change line describing them all', async () => {
    const s = open();
    const tab = s.active;
    if (tab.type !== 'model') throw new Error('expected a model tab');
    const tools = documentToolsFor(s, tab)!;
    const doc = tab.app.document.doc, undo = tab.app.document.undoStack, depth = undo.length;
    const grain = (label: string, x: number) => tools.run({ id: label, name: 'model_apply_operations',
      input: { expectedRevision: doc.version, label, operations: [{ op: 'add_box', min: [x, 0, 0], max: [x + 0.5, 0.5, 0.5] }] } });
    expect((await grain('Grain left side', 0)).notice).toBe('Changed the document: Grain left side. Undo reverts it.');
    expect((await grain('Grain right side', 1)).notice).toBe('Changed the document: Grain left side and 1 more change. Undo reverts it.');
    expect((await grain('Grain toe kick', 2)).notice).toBe('Changed the document: Grain left side and 2 more changes. Undo reverts it.');
    expect(undo.length).toBe(depth + 1);
    expect(undo.peek()?.label).toBe('AI Chat: Grain left side and 2 more changes');
    const root = () => tab.app.document.doc.rootDefinition.entities;
    expect(root().bodies.size).toBe(3);
    // The requester edits meanwhile: the next batch is its own undo step, and the line says how many there are.
    tab.app.commands.execute('model.addBox', { min: [5, 0, 0], max: [6, 1, 1] });
    expect((await grain('Grain back', 3)).notice).toBe('Changed the document: Grain left side and 3 more changes. Undo reverts it in 2 steps.');
    expect(tab.app.commands.execute('edit.undo')).toBe(true);
    expect(tab.app.commands.execute('edit.undo')).toBe(true);
    expect(tab.app.commands.execute('edit.undo')).toBe(true);
    expect(root().bodies.size).toBe(0);
    // A new message gets a new API object, so its batches are a new undo step.
    const next = documentToolsFor(s, tab)!;
    const fresh = await next.run({ id: 'n', name: 'model_apply_operations', input: { expectedRevision: doc.version, label: 'Shelf', operations: [{ op: 'add_box', min: [0, 0, 0], max: [1, 1, 1] }] } });
    expect(fresh.notice).toBe('Changed the document: Shelf. Undo reverts it.');
  });

  it('renders the bound model offscreen as JPEG pictures for review without moving the view or adding undo', async () => {
    const s = open();
    const tab = s.active;
    if (tab.type !== 'model') throw new Error('expected a model tab');
    tab.app.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 0.5, 2] });
    const tools = documentToolsFor(s, tab)!;
    const viewport = tab.app.viewport;
    const before = viewport.camera.getState(), undo = tab.app.document.undoStack.peek();
    // Headless: no renderer, so the call answers unavailable.
    const headless = await tools.run({ id: 'r0', name: 'model_render', input: {} });
    expect(headless.isError).toBe(true);
    expect(JSON.parse(headless.content).error.code).toBe('unavailable');
    expect(headless.images).toBeUndefined();
    // With the tab's viewport drawing (mocked here), each view is one JPEG at most 1024 pixels on its longer side.
    const sizes: [number, number][] = [];
    const snapshot = vi.spyOn(viewport, 'snapshotInto').mockImplementation((target, width, height) => { sizes.push([width, height]); target.width = width; target.height = height; return true; });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, done: BlobCallback, type?: string) { done({ type, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]).buffer } as unknown as Blob); });
    expect(tools.progress?.({ id: 'r1', name: 'model_render', input: {} })).toBe('Checking the result…');
    const outcome = await tools.run({ id: 'r1', name: 'model_render', input: {} });
    expect(outcome.isError).toBe(false);
    expect(outcome.notice).toBeUndefined();
    expect(outcome.images).toEqual([{ mime: 'image/jpeg', data: '/9j/AQID' }, { mime: 'image/jpeg', data: '/9j/AQID' }]);
    expect(outcome.views).toEqual(['iso', 'front']);
    expect(JSON.parse(outcome.content)).toMatchObject({ ok: true, views: [{ name: 'iso' }, { name: 'front' }] });
    expect(snapshot).toHaveBeenCalledTimes(2);
    for (const [w, h] of sizes) expect(Math.max(w, h)).toBeLessThanOrEqual(1024);
    expect(Math.max(...sizes[0]!)).toBe(1024);
    // The framed cameras differ from the requester's, which stays as it was; nothing joins the undo history.
    expect(snapshot.mock.calls[0]![3]).not.toEqual(before);
    expect(viewport.camera.getState()).toEqual(before);
    expect(tab.app.document.undoStack.peek()).toBe(undo);
    const three = await tools.run({ id: 'r2', name: 'model_render', input: { views: [{ direction: 'top' }, { direction: 'left', orbitDeg: { horizontal: 20 } }, { direction: 'back', subject: 'model' }] } });
    expect(three.views).toEqual(['top', 'left, orbited', 'back of the model']);
    const four = await tools.run({ id: 'r3', name: 'model_render', input: { views: [{ direction: 'top' }, { direction: 'top' }, { direction: 'top' }, { direction: 'top' }] } });
    expect(JSON.parse(four.content).error.code).toBe('invalid_operation');
  });

  it('edits the tab it was bound to as one undo entry and returns a transcript line', async () => {
    const s = open();
    const tab = s.newLayout();
    const tools = documentToolsFor(s, tab)!;
    const pageId = tab.doc.state.pageOrder[0]!;
    const revision = JSON.parse((await tools.run({ id: 'a', name: 'layout_get_document', input: {} })).content).revision as number;
    const outcome = await tools.run({ id: 'b', name: 'layout_apply_operations', input: { expectedRevision: revision, label: 'Frame', operations: [{ op: 'add_rectangle', pageId, x: 10, y: 10, width: 50, height: 20 }] } });
    expect(outcome.isError).toBe(false);
    expect(outcome.notice).toBe('Changed the document: Frame. Undo reverts it.');
    expect(tab.doc.state.pages.get(pageId)!.entities.size).toBe(1);
    expect(tab.commands.execute('edit.undo')).toBe(true);
    expect(tab.doc.state.pages.get(pageId)!.entities.size).toBe(0);
  });

  it('changes nothing once another tab is active or the bound tab is closed', async () => {
    const s = open();
    const modelId = s.activeId;
    const tab = s.newLayout();
    const tools = documentToolsFor(s, tab)!;
    const pageId = tab.doc.state.pageOrder[0]!;
    const batch = { expectedRevision: tab.doc.version, label: 'Frame', operations: [{ op: 'add_rectangle', pageId, x: 10, y: 10, width: 50, height: 20 }] };
    s.activate(modelId);
    const switched = await tools.run({ id: 'b', name: 'layout_apply_operations', input: batch });
    expect(switched.isError).toBe(true);
    expect(JSON.parse(switched.content).error.code).toBe('unavailable');
    s.activate(tab.id);
    s.close(tab.id, true);
    const closed = await tools.run({ id: 'c', name: 'layout_apply_operations', input: batch });
    expect(JSON.parse(closed.content).error.message).toContain('was closed');
    expect(tab.doc.state.pages.get(pageId)!.entities.size).toBe(0);
  });
});


it('keeps guidance outside the extension protocol and command registry', () => {
  const s = open(), tab = s.newLayout();
  const api = new LayoutDocumentApi(tab.doc, tab.commands, { activePageId: () => tab.activePageId, selectedEntityIds: () => [] }, 'Test');
  expect(Object.values(LAYOUT_TOOLS).some(tool => tool.name.startsWith('ui_'))).toBe(false);
  for (const name of ['ui_list_targets', 'ui_open_sidebar', 'ui_highlight']) {
    expect(runLayoutTool(api, name, {}).isError).toBe(true);
    expect(tab.commands.list().some(command => command.id === name)).toBe(false);
  }
  expect(documentToolsFor(s, tab, () => {})?.document.guidance).toBe(1);
});
