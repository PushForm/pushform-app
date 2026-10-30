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
  it('offers nothing for a model tab and the Layout API for a Layout tab', () => {
    const s = open();
    expect(s.active.type).toBe('model');
    expect(documentToolsFor(s, s.active)).toBeNull();
    expect(documentToolsFor(s, s.newLayout())?.document).toEqual({ type: 'layout', apiVersion: 1 });
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
