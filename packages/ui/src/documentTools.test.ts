// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { LAYOUT_TOOLS } from '@pushform/extension-protocol';
import { LayoutDocumentApi, runLayoutTool } from '@pushform/extensions';
import { createApp } from './bootstrap';
import { documentToolsFor } from './documentTools';
import { DocumentSession } from './session';

let session: DocumentSession | null = null;
afterEach(() => {
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
