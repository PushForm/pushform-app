// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from './layout';
import {
  LAYOUT_TOOLS,
  LAYOUT_TOOL_IDS,
  SERVICE_LAYOUT_WORKSPACE,
  layoutToolCommandId,
  type LayoutWorkspaceHost,
} from './layoutTools';

describe('layout tool commands', () => {
  it('registers one tool.* command per Layout tool with icon, title and shortcut label', () => {
    const { commands } = createLayoutRegistry(createLayoutDocument());
    expect(new Set(LAYOUT_TOOLS.map((t) => t.id))).toEqual(new Set(LAYOUT_TOOL_IDS));
    const tools = commands.list({ category: 'tool' });
    expect(tools.map((c) => c.id).sort()).toEqual(LAYOUT_TOOL_IDS.map(layoutToolCommandId).sort());
    const line = tools.find((c) => c.id === 'tool.line')!;
    expect(line).toMatchObject({
      title: 'Line',
      icon: 'tool-line',
      keybinding: 'L',
      undoable: false,
    });
    expect(tools.find((c) => c.id === 'tool.freehand')!.keybinding).toBeUndefined();
    expect(new Set(tools.map((c) => c.title)).size).toBe(tools.length);
    expect(commands.has('tool.pushpull')).toBe(false);
  });

  it('is disabled until a workspace installs a tool host, then activates that host', () => {
    const { commands } = createLayoutRegistry(createLayoutDocument());
    expect(commands.isEnabled('tool.line')).toBe(false);
    expect(() => commands.execute('tool.line')).toThrow(/not enabled/);
    const activated: string[] = [];
    commands.ctx.tools = { activate: (id) => activated.push(id), activeToolId: 'select' };
    expect(commands.isEnabled('tool.angular-dimension')).toBe(true);
    commands.execute('tool.angular-dimension');
    commands.execute('tool.rounded-rectangle', {});
    expect(activated).toEqual(['angular-dimension', 'rounded-rectangle']);
    commands.ctx.tools = undefined;
    expect(commands.isEnabled('tool.line')).toBe(false);
  });

  it('offers Presentation Mode as a view command while a workspace is mounted', () => {
    const { commands } = createLayoutRegistry(createLayoutDocument());
    expect(commands.list({ category: 'view' }).map((c) => c.id)).toEqual(['layout.present', 'layout.zoom.page', 'layout.zoom.content']);
    expect(commands.get('layout.present')).toMatchObject({
      title: 'Presentation Mode',
      icon: 'presentation',
    });
    expect(commands.isEnabled('layout.present')).toBe(false);
    const host: LayoutWorkspaceHost = { present: vi.fn(), print: vi.fn(), exportImage: vi.fn(), importImage: vi.fn(), zoomToPage: vi.fn(), fitContent: vi.fn(), addLayer: vi.fn(), documentSettings: vi.fn() };
    commands.ctx.services.set(SERVICE_LAYOUT_WORKSPACE, host);
    expect(commands.isEnabled('layout.present')).toBe(true);
    commands.execute('layout.present');
    expect(host.present).toHaveBeenCalledTimes(1);
  });

  it('opens Document Settings as a file command only while a workspace is mounted', () => {
    const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc);
    expect(commands.get('layout.document.settings')).toMatchObject({ title: 'Document Settings', category: 'file', undoable: false });
    expect(commands.isEnabled('layout.document.settings')).toBe(false);
    const host: LayoutWorkspaceHost = { present: vi.fn(), print: vi.fn(), exportImage: vi.fn(), importImage: vi.fn(), zoomToPage: vi.fn(), fitContent: vi.fn(), addLayer: vi.fn(), documentSettings: vi.fn() };
    commands.ctx.services.set(SERVICE_LAYOUT_WORKSPACE, host);
    const version = doc.version;
    commands.execute('layout.document.settings');
    expect(host.documentSettings).toHaveBeenCalledTimes(1);
    expect(doc.version).toBe(version);
  });

  it('runs zoom actions only while mounted without changing the document or undo history', () => {
    const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc);
    const host: LayoutWorkspaceHost = { present: vi.fn(), print: vi.fn(), exportImage: vi.fn(), importImage: vi.fn(), zoomToPage: vi.fn(), fitContent: vi.fn(), addLayer: vi.fn(), documentSettings: vi.fn() };
    for (const id of ['layout.zoom.page', 'layout.zoom.content']) {
      expect(commands.isEnabled(id)).toBe(false);
      expect(() => commands.execute(id)).toThrow(/not enabled/);
    }
    commands.ctx.services.set(SERVICE_LAYOUT_WORKSPACE, host);
    const version = doc.version;
    commands.execute('layout.zoom.page'); commands.execute('layout.zoom.content');
    expect(host.zoomToPage).toHaveBeenCalledOnce(); expect(host.fitContent).toHaveBeenCalledOnce();
    expect(doc.version).toBe(version); expect(doc.undoStack.canUndo).toBe(false);
    commands.ctx.services.delete(SERVICE_LAYOUT_WORKSPACE);
    expect(commands.isEnabled('layout.zoom.page')).toBe(false);
    expect(commands.isEnabled('layout.zoom.content')).toBe(false);
  });
});

it('offers Import as a file action enabled only while its Layout workspace is mounted', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc);
  expect(commands.get('layout.import')).toMatchObject({ title: 'Import', icon: 'image', category: 'file', undoable: false });
  expect(commands.isEnabled('layout.import')).toBe(false);
  const host: LayoutWorkspaceHost = { present: vi.fn(), print: vi.fn(), exportImage: vi.fn(), importImage: vi.fn(), zoomToPage: vi.fn(), fitContent: vi.fn(), addLayer: vi.fn(), documentSettings: vi.fn() };
  commands.ctx.services.set(SERVICE_LAYOUT_WORKSPACE, host);
  const version = doc.version;
  commands.execute('layout.import'); expect(host.importImage).toHaveBeenCalledOnce();
  expect(doc.version).toBe(version); expect(doc.undoStack.canUndo).toBe(false);
  commands.ctx.services.delete(SERVICE_LAYOUT_WORKSPACE); expect(commands.isEnabled('layout.import')).toBe(false);
});

it('offers Export as a file action enabled only while its Layout workspace is mounted', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc);
  expect(commands.get('layout.export.image')).toMatchObject({ title: 'Export', category: 'file', menu: 'File', undoable: false });
  expect(commands.isEnabled('layout.export.image')).toBe(false);
  const host: LayoutWorkspaceHost = { present: vi.fn(), print: vi.fn(), exportImage: vi.fn(), importImage: vi.fn(), zoomToPage: vi.fn(), fitContent: vi.fn(), addLayer: vi.fn(), documentSettings: vi.fn() };
  commands.ctx.services.set(SERVICE_LAYOUT_WORKSPACE, host);
  const version = doc.version;
  commands.execute('layout.export.image'); expect(host.exportImage).toHaveBeenCalledOnce();
  expect(doc.version).toBe(version); expect(doc.undoStack.canUndo).toBe(false);
  commands.ctx.services.delete(SERVICE_LAYOUT_WORKSPACE); expect(commands.isEnabled('layout.export.image')).toBe(false);
});

it('activates the Scale tool before selecting an object', () => {
  const { commands } = createLayoutRegistry(createLayoutDocument());
  const activate = vi.fn();
  expect(commands.isEnabled('tool.scale')).toBe(false);
  commands.ctx.tools = { activate, activeToolId: 'select' };
  commands.execute('tool.scale');
  expect(activate).toHaveBeenCalledWith('scale');
});
