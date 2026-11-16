// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useState, type JSX } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { zipSync } from 'fflate';
import { CommandRegistry, MemoryTransactionHost } from '@pushform/commands';
import { DEFAULT_UNITS } from '@pushform/core';
import { buildManifest, type ExtensionManifestInput, type ExtensionPermission, type ModelRef } from '@pushform/extension-protocol';
import {
  ExtensionPlatform, memoryDeveloperMode, memoryExtensionStore, memorySettingsStore, messagePortTransport, startGuest, type ExtensionContext,
  type ExtensionDocuments, type ExtensionPlatformOptions, type ExtensionStore,
} from '@pushform/extensions';
import { searchCommands } from '../components/CommandSearch';
import { SideRail } from '../components/SideRail';
import type { DocumentTab } from '../session';
import { ExtensionActivity, ExtensionRuns } from './ExtensionActivity';
import { ExtensionSidebar } from './ExtensionSidebar';
import { ExtensionTabView } from './ExtensionTabView';
import { activityExtensions, extensionToolbarButtons, selectionActionGroups, syncExtensionCommands } from './extensionContributions';
import { ExtensionTabs, extensionTabId } from './extensionTabs';
import { useExtensionWorkspace, type ExtensionWorkspaceRailId, type ExtensionsPanelOptions } from './useExtensionWorkspace';

const encode = (s: string) => new TextEncoder().encode(s);
const SIDE = 'com.example.parts.side';
const PANEL = 'com.example.parts.panel';
const manifest = {
  id: 'com.example.parts', name: 'Parts', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'],
  defaultLocale: 'en', license: 'MIT', permissions: ['selection.write'], icon: 'saw-blade',
  contributions: [
    { target: 'model.sidebar', id: SIDE, name: 'Parts' },
    { target: 'model.panel', id: PANEL, name: 'Parts list' },
    { target: 'model.command', id: 'com.example.parts.export', name: 'Export parts' },
    { target: 'model.tool', id: 'com.example.parts.draw', name: 'Draw part' },
    { target: 'model.selection.action', id: 'com.example.parts.label', name: 'Label selected parts' },
    { target: 'model.toolbar', id: 'com.example.parts.cut', name: 'Cut parts', category: 'modify', icon: 'saw-blade' },
  ],
} satisfies Omit<ExtensionManifestInput, 'files'>;

const channels: MessageChannel[] = [];
afterEach(() => { cleanup(); for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

/** A platform with the Parts extension installed, running `module` in this process. */
async function setup(module: unknown = { activate() {} }, store: ExtensionStore = memoryExtensionStore(),
  options: Partial<ExtensionPlatformOptions> = {}, grants: readonly ExtensionPermission[] = []) {
  const terminated: string[] = [];
  const platform = new ExtensionPlatform({
    store, developerMode: memoryDeveloperMode(true), settingsStore: () => memorySettingsStore(),
    startRuntime: async () => {
      const channel = new MessageChannel();
      channels.push(channel);
      void startGuest(messagePortTransport(channel.port2), async () => module);
      return { port: messagePortTransport(channel.port1), terminate: () => terminated.push('parts') };
    },
    ...options,
  });
  const files = new Map<string, Uint8Array>([['main.js', encode('export function activate() {}')]]);
  files.set('manifest.json', await buildManifest(manifest, files));
  await platform.install(await platform.sideload(zipSync(Object.fromEntries(files))), grants);
  return { platform, terminated };
}

const registry = () => new CommandRegistry({ tx: new MemoryTransactionHost(), services: new Map() });
const extensionOf = (platform: ExtensionPlatform) => activityExtensions(platform, 'modeling')[0]!;
const panelOf = (platform: ExtensionPlatform) => extensionOf(platform).contributions.find((c) => c.target === 'model.panel')!;
const tabStore = (activated: string[] = []) => new ExtensionTabs({ activateDocument: (id) => activated.push(id), isOpen: (id) => id.startsWith('tab-') });
type Ui = { mount(i: unknown): Promise<unknown>; update(i: unknown): Promise<unknown>; open(i: unknown): Promise<unknown>; dialog(i: unknown): Promise<unknown>;
  closeDialog(i: unknown): Promise<unknown>; onEvent(h: (e: Record<string, unknown>) => void): void };

/** Mounts a text for a target when its contribution runs. */
const mounts = (trees: Record<string, string>) => ({
  activate(context: ExtensionContext) {
    const ui = context.ui as unknown as Ui;
    for (const [target, text] of Object.entries(trees))
      context.commands.register(target, () => ui.mount({ target, seq: 1, tree: { type: 'text', id: 't', text } }));
  },
});

describe('extension commands', () => {
  it('appear in command search and the selection menu under the extension name, with the toolbar button and the panel, and leave when it is turned off', async () => {
    const { platform } = await setup();
    const commands = registry();
    const ran: string[] = [];
    const stop = syncExtensionCommands(commands, platform, 'modeling', (entry) => ran.push(entry.id));
    expect(searchCommands(commands, null, 'export')).toEqual([expect.objectContaining({ id: 'extension:com.example.parts.export', title: 'Export parts', source: 'Parts' })]);
    // The extension's name finds its commands too.
    expect(searchCommands(commands, null, 'parts').map((i) => i.id)).toContain('extension:com.example.parts.label');
    // The toolbar button and the panel are searchable as well; the sidebar is not a command.
    expect(commands.has('extension:com.example.parts.cut')).toBe(true);
    expect(commands.has('extension:com.example.parts.draw')).toBe(true);
    expect(commands.has(`extension:${PANEL}`)).toBe(true);
    expect(commands.has(`extension:${SIDE}`)).toBe(false);
    expect(selectionActionGroups(commands)).toEqual([
      expect.objectContaining({ label: 'Parts', children: [expect.objectContaining({ label: 'Label selected parts', command: 'extension:com.example.parts.label' })] }),
    ]);
    await commands.execute('extension:com.example.parts.export', {});
    await commands.execute(`extension:${PANEL}`, {});
    expect(ran).toEqual(['com.example.parts.export', PANEL]);
    // Registering ran no extension code.
    expect(platform.state('com.example.parts')!.run).toBe('stopped');

    await platform.setEnabled('com.example.parts', false);
    expect(commands.has('extension:com.example.parts.export')).toBe(false);
    expect(activityExtensions(platform, 'modeling')).toEqual([]);
    expect(extensionToolbarButtons(platform, 'modeling')).toEqual([]);
    await platform.setEnabled('com.example.parts', true);
    expect(commands.has('extension:com.example.parts.export')).toBe(true);
    expect(extensionToolbarButtons(platform, 'modeling')).toEqual([expect.objectContaining({ id: 'com.example.parts.cut', category: 'modify', icon: 'saw-blade' })]);
    // An editor the extension does not support gets none of it.
    const layout = registry();
    syncExtensionCommands(layout, platform, 'layout', () => {});
    expect(layout.list().filter((c) => c.id.startsWith('extension:'))).toEqual([]);
    expect(activityExtensions(platform, 'layout')).toEqual([]);
    stop();
    expect(commands.has('extension:com.example.parts.export')).toBe(false);
  });

  it('show while running, can be cancelled, and report a failure', async () => {
    let release = (): void => {};
    const { platform } = await setup({
      activate(context: ExtensionContext) {
        context.commands.register('com.example.parts.export', (_params: unknown, { signal }: { signal: AbortSignal }) => new Promise((resolve) => {
          release = () => resolve(null);
          signal.addEventListener('abort', () => resolve(null));
        }));
        context.commands.register('com.example.parts.label', () => { throw new Error('Nothing selected'); });
      },
    });
    const runs = new ExtensionRuns(platform);
    render(<ExtensionActivity runs={runs} platform={platform} />);
    const entry = (target: string) => platform.contributions('modeling').find((e) => e.target === target)!;
    const exporter = entry('model.command'), label = entry('model.selection.action');
    void runs.start(exporter, 'tab-1');
    expect(await screen.findByText('Export parts')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Export parts')).toBeNull();
    await act(() => runs.start(label, 'tab-1'));
    expect(screen.getByRole('status').textContent).toMatch(/Label selected parts \(Parts\).*Nothing selected/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    release();
  });
});

describe('extension failures', () => {
  it('names the extension and action, and offers Restart and Disable', async () => {
    const { platform } = await setup({ activate() { throw new Error('Out of memory'); } });
    const runs = new ExtensionRuns(platform);
    render(<ExtensionActivity runs={runs} platform={platform} />);
    const exporter = platform.contributions('modeling').find((e) => e.target === 'model.command')!;
    await act(() => runs.start(exporter, 'tab-1'));
    const notice = screen.getByRole('alert');
    expect(notice.textContent).toMatch(/Parts stopped while running Export parts\. Work it had not finished was discarded/);
    expect(notice.textContent).toContain('Out of memory');
    // The failed command is not listed a second time.
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disable' })); });
    expect(platform.state('com.example.parts')!.record.enabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says when an extension was turned off for failing repeatedly, and turns it back on', async () => {
    const { platform } = await setup({ activate() { throw new Error('broken'); } });
    for (let i = 0; i < 3; i++) await platform.invoke('com.example.parts', 'com.example.parts.export').catch(() => {});
    render(<ExtensionActivity runs={new ExtensionRuns(platform)} platform={platform} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Parts stopped 3 times in 10 minutes and was turned off/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Turn on and restart' })); });
    expect(platform.state('com.example.parts')).toMatchObject({ run: 'stopped', record: { enabled: true } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says when an installed extension was not started because its files changed, and lists none of its commands', async () => {
    const store = memoryExtensionStore();
    const { platform: first } = await setup(undefined, store);
    const [record] = await store.list();
    await store.put({ ...record!, files: { ...record!.files, 'main.js': encode('export function activate() { /* changed */ }') } });
    let started = false;
    const platform = new ExtensionPlatform({
      store, developerMode: memoryDeveloperMode(true), settingsStore: () => memorySettingsStore(),
      startRuntime: async () => { started = true; throw new Error('must not start'); },
    });
    await first.stopAll();
    await platform.load();
    const commands = registry();
    syncExtensionCommands(commands, platform, 'modeling', () => {});
    expect(commands.list().filter((c) => c.id.startsWith('extension:'))).toEqual([]);
    expect(activityExtensions(platform, 'modeling')).toEqual([]);
    render(<ExtensionActivity runs={new ExtensionRuns(platform)} platform={platform} />);
    const notice = screen.getByRole('alert');
    expect(notice.textContent).toMatch(/Parts was not started because its installed files could not be verified/);
    expect(notice.textContent).toContain('"main.js" does not match its hash in the manifest.');
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disable' })); });
    expect(platform.state('com.example.parts')!.record.enabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(started).toBe(false);
  });
});

describe('extension side panels', () => {
  it('open in a PushForm frame naming the extension, mount the sidebar contribution, and remove it when closed', async () => {
    const { platform } = await setup(mounts({ [SIDE]: '12 parts' }));
    const view = render(<ExtensionSidebar platform={platform} extension={extensionOf(platform)} units={DEFAULT_UNITS} documentId="tab-1" onClose={() => {}} />);
    const frame = screen.getByRole('region', { name: 'Parts side panel' });
    expect(within(frame).getByRole('heading', { name: 'Parts' })).toBeTruthy();
    expect(frame.textContent).toContain('Unsigned (developer)');
    expect(await screen.findByText('12 parts')).toBeTruthy();
    expect(platform.ui('com.example.parts')!.get(SIDE)).toBeTruthy();
    // One sidebar contribution: no tab strip.
    expect(screen.queryByRole('tablist')).toBeNull();
    view.unmount();
    expect(platform.ui('com.example.parts')!.get(SIDE)).toBeUndefined();
  });

  it('say when the extension fails to open it, and offer Restart after it failed', async () => {
    let starts = 0;
    const { platform } = await setup({
      activate(context: ExtensionContext) {
        if (++starts === 1) throw new Error('First start failed');
        context.commands.register(SIDE, () => { throw new Error('No model open'); });
      },
    });
    render(<ExtensionSidebar platform={platform} extension={extensionOf(platform)} units={DEFAULT_UNITS} documentId="tab-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart Parts' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/No model open/));
  });

  it('show several sidebar contributions as a tab strip, running only the chosen one', async () => {
    const second = 'com.example.parts.sheets';
    const multi = { ...manifest, contributions: [...manifest.contributions, { target: 'model.sidebar' as const, id: second, name: 'Sheets' }] };
    const files = new Map<string, Uint8Array>([['main.js', encode('export function activate() {}')]]);
    files.set('manifest.json', await buildManifest(multi, files));
    const { platform } = await setup(mounts({ [SIDE]: 'The parts', [second]: 'The sheets' }));
    await platform.install(await platform.sideload(zipSync(Object.fromEntries(files))), []);
    render(<ExtensionSidebar platform={platform} extension={extensionOf(platform)} units={DEFAULT_UNITS} documentId="tab-1" onClose={() => {}} />);
    const strip = screen.getByRole('tablist', { name: 'Parts views' });
    expect(within(strip).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Parts', 'Sheets']);
    expect(await screen.findByText('The parts')).toBeTruthy();
    expect(platform.ui('com.example.parts')!.get(second)).toBeUndefined();
    fireEvent.click(within(strip).getByRole('tab', { name: 'Sheets' }));
    expect(await screen.findByText('The sheets')).toBeTruthy();
    expect(screen.queryByText('The parts')).toBeNull();
    expect(platform.ui('com.example.parts')!.get(SIDE)).toBeUndefined();
  });
});

describe('extension tabs', () => {
  it('open once per panel and document, come to the front with their document, close, and close with their document', () => {
    const activated: string[] = [];
    const tabs = tabStore(activated);
    const entry = { extensionId: 'com.example.parts', extensionName: 'Parts', integrity: 'unsigned' as const, id: PANEL, target: 'model.panel' as const, name: 'Parts list' };
    tabs.open(entry, 'tab-1');
    tabs.open(entry, 'tab-2');
    tabs.open(entry, 'tab-1');
    expect(tabs.tabs.map((t) => t.id)).toEqual([extensionTabId(PANEL, 'tab-1'), extensionTabId(PANEL, 'tab-2')]);
    expect(tabs.activeTab?.documentId).toBe('tab-1');
    expect(activated).toEqual(['tab-1', 'tab-2', 'tab-1']);
    // A document that is not open gets no tab.
    tabs.open(entry, 'closed');
    expect(tabs.tabs).toHaveLength(2);
    // Choosing a document tab leaves the extension tab open, behind it.
    tabs.activate(null);
    expect(tabs.activeId).toBeNull();
    expect(tabs.tabs).toHaveLength(2);
    tabs.activate(extensionTabId(PANEL, 'tab-2'));
    expect(activated.at(-1)).toBe('tab-2');
    // Switching to another document puts the editor in front; switching to the tab's own document does not.
    tabs.documentActivated('tab-2');
    expect(tabs.activeId).toBe(extensionTabId(PANEL, 'tab-2'));
    tabs.documentActivated('tab-1');
    expect(tabs.activeId).toBeNull();
    tabs.activate(extensionTabId(PANEL, 'tab-2'));
    tabs.closeDocument('tab-2');
    expect(tabs.tabs.map((t) => t.documentId)).toEqual(['tab-1']);
    expect(tabs.activeId).toBeNull();
    tabs.close(extensionTabId(PANEL, 'tab-1'));
    expect(tabs.tabs).toEqual([]);
  });

  it('show the panel in a frame naming it and the extension, and unmount it when the tab closes', async () => {
    const { platform } = await setup(mounts({ [PANEL]: 'All 12 parts, with sheets' }));
    const tabs = tabStore();
    tabs.open(panelOf(platform), 'tab-1');
    const view = render(<ExtensionTabView platform={platform} tab={tabs.activeTab!} units={DEFAULT_UNITS} />);
    const frame = screen.getByRole('region', { name: 'Parts list, from Parts' });
    expect(within(frame).getByRole('heading', { name: 'Parts list' })).toBeTruthy();
    expect(frame.textContent).toContain('Unsigned (developer)');
    expect(await screen.findByText('All 12 parts, with sheets')).toBeTruthy();
    expect(platform.ui('com.example.parts')!.get(PANEL)).toBeTruthy();
    view.unmount();
    expect(platform.ui('com.example.parts')!.get(PANEL)).toBeUndefined();
  });

  it('open from the sidebar through ui.open, for the extension own panel and the sidebar document', async () => {
    const tabs = tabStore();
    const ref: { platform?: ExtensionPlatform } = {};
    const { platform } = await setup({
      activate(context: ExtensionContext) {
        const ui = context.ui as unknown as Ui;
        context.commands.register(SIDE, () => ui.mount({ target: SIDE, seq: 1, tree: { type: 'button', id: 'open', label: 'Open the full list' } }));
        ui.onEvent((e) => { if (e.component === 'open') void ui.open({ target: PANEL }); });
      },
    }, undefined, { openUi: (request) => tabs.openRequest(ref.platform!, request) });
    ref.platform = platform;
    render(<ExtensionSidebar platform={platform} extension={extensionOf(platform)} units={DEFAULT_UNITS} documentId="tab-3" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open the full list' }));
    await waitFor(() => expect(tabs.activeTab).toMatchObject({ documentId: 'tab-3', entry: { id: PANEL, target: 'model.panel' } }));
    // Asked for by something other than the extension's own panel, nothing opens.
    tabs.openRequest(platform, { extensionId: 'com.example.parts', target: SIDE, documentId: 'tab-3' });
    tabs.openRequest(platform, { extensionId: 'com.other', target: PANEL, documentId: 'tab-3' });
    expect(tabs.tabs).toHaveLength(1);
  });

  it('give way to the document when the extension sets or frames its selection from the tab', async () => {
    const tabs = tabStore();
    const selected: unknown[] = [];
    const documents: ExtensionDocuments = {
      get: (id) => ({
        name: () => id, units: () => ({ system: 'metric', lengthUnit: 'mm', format: 'decimal', lengthPrecision: 1 }), listen: () => () => {},
        model: () => ({ revision: 1, getDocument: () => { throw new Error('unused'); }, query: () => { throw new Error('unused'); }, apply: async () => { throw new Error('unused'); },
          selection: () => [], select: (refs) => { selected.push(refs); return refs as ModelRef[]; }, frame: () => null }),
      }),
    };
    const { platform } = await setup({
      activate(context: ExtensionContext) {
        const ui = context.ui as unknown as Ui;
        const selection = context.selection as unknown as { set(i: unknown): Promise<unknown> };
        context.commands.register(PANEL, () => ui.mount({ target: PANEL, seq: 1, tree: { type: 'button', id: 'show', label: 'Show part 1' } }));
        ui.onEvent((e) => { if (e.component === 'show') void selection.set({ refs: [{ kind: 'body', id: 1 }] }); });
      },
    }, undefined, { documents, onSelectionShown: (extensionId, documentId) => tabs.selectionShown(extensionId, documentId) }, ['selection.write']);
    tabs.open(panelOf(platform), 'tab-1');
    render(<ExtensionTabView platform={platform} tab={tabs.activeTab!} units={DEFAULT_UNITS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show part 1' }));
    await waitFor(() => expect(selected).toEqual([[{ kind: 'body', id: 1 }]]));
    // The document's tab is in front; the extension tab stays open.
    await waitFor(() => expect(tabs.activeId).toBeNull());
    expect(tabs.tabs).toHaveLength(1);
    // A selection of another document, or by another extension, leaves the tab in front.
    tabs.activate(extensionTabId(PANEL, 'tab-1'));
    tabs.selectionShown('com.example.parts', 'tab-2');
    tabs.selectionShown('com.other', 'tab-1');
    expect(tabs.activeId).toBe(extensionTabId(PANEL, 'tab-1'));
  });
});

describe('extension dialogs', () => {
  const heard: Record<string, unknown>[] = [];
  const materials = (target: string) => ({
    activate(context: ExtensionContext) {
      const ui = context.ui as unknown as Ui;
      let seq = 0;
      const dialog = (name: string) => ui.dialog({ target, seq: ++seq, title: 'Edit material', tree: { type: 'stack', id: 'editor', children: [
        { type: 'textField', id: 'name', label: 'Material name', value: name },
        { type: 'stack', id: 'buttons', direction: 'horizontal', children: [{ type: 'button', id: 'save', label: 'Save', variant: 'primary' }, { type: 'button', id: 'cancel', label: 'Cancel' }] },
      ] } });
      ui.onEvent((e) => {
        heard.push(e);
        if (e.component === 'edit') void dialog('Oak');
        if (e.component === 'name' && e.event === 'change') void dialog(String(e.value));
        if (e.component === 'cancel' || e.component === 'save') void ui.closeDialog({ target });
      });
      context.commands.register(target, () => ui.mount({ target, seq: 1, tree: { type: 'stack', id: 'root', children: [
        { type: 'text', id: 't', text: '2 materials' }, { type: 'button', id: 'edit', label: 'Edit Oak' },
      ] } }));
    },
  });

  it('show a modal dialog drawn by PushForm over the side panel, route its events, and report the user closing it', async () => {
    heard.length = 0;
    const { platform } = await setup(materials(SIDE));
    render(<ExtensionSidebar platform={platform} extension={extensionOf(platform)} units={DEFAULT_UNITS} documentId="tab-1" onClose={() => {}} />);
    const edit = await screen.findByRole('button', { name: 'Edit Oak' });
    edit.focus();
    fireEvent.click(edit);
    const dialog = await screen.findByRole('dialog', { name: 'Edit material' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.closest('.pf-xdialog-backdrop')).toBeTruthy();
    // Focus starts on the first field and Tab cycles inside.
    const name = within(dialog).getByLabelText('Material name') as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(name));
    fireEvent.keyDown(name, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Its events reach the extension, which replaces the tree in place.
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: 'Oak, quarter sawn' } });
    fireEvent.blur(name);
    await waitFor(() => expect(heard.at(-1)).toEqual({ target: SIDE, component: 'name', event: 'change', value: 'Oak, quarter sawn' }));
    await waitFor(() => expect((within(screen.getByRole('dialog', { name: 'Edit material' })).getByLabelText('Material name') as HTMLInputElement).value).toBe('Oak, quarter sawn'));
    expect(screen.getByRole('dialog', { name: 'Edit material' })).toBe(dialog);
    // Escape closes it at once, the extension hears dialogClose, and focus returns.
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Save' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(edit);
    await waitFor(() => expect(heard.at(-1)).toEqual({ target: SIDE, component: 'editor', event: 'dialogClose' }));
    // The extension closes it too.
    fireEvent.click(edit);
    const again = await screen.findByRole('dialog', { name: 'Edit material' });
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(heard.filter((e) => e.event === 'dialogClose')).toHaveLength(1);
    // The Close button closes it as well.
    fireEvent.click(edit);
    const third = await screen.findByRole('dialog', { name: 'Edit material' });
    fireEvent.click(within(third).getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(heard.filter((e) => e.event === 'dialogClose')).toHaveLength(2));
  });

  it('show over an extension tab as well, in the app root above the tab content', async () => {
    heard.length = 0;
    const { platform } = await setup(materials(PANEL));
    const tabs = tabStore();
    tabs.open(panelOf(platform), 'tab-1');
    render(<div className="pf-app"><ExtensionTabView platform={platform} tab={tabs.activeTab!} units={DEFAULT_UNITS} /></div>);
    const frame = screen.getByRole('region', { name: 'Parts list, from Parts' });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Oak' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit material' });
    // The dialog is portalled to the app root, not into the tab's content.
    expect(frame.contains(dialog)).toBe(false);
    expect(dialog.closest('.pf-xdialog-backdrop')?.parentElement).toBe(document.querySelector('.pf-app'));
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Save' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Edit material' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Parts list, from Parts' })).toBeTruthy();
    await waitFor(() => expect(heard.at(-1)).toEqual({ target: PANEL, component: 'editor', event: 'dialogClose' }));
  });
});

describe('the Extensions item in the activity bar', () => {
  const PANEL_KEY = 'pushform:extensions:panel:u1:modeling';
  const tab = { id: 'tab-1', type: 'model', app: { commands: registry(), document: { doc: { state: { meta: { units: DEFAULT_UNITS } } } } } } as unknown as DocumentTab;
  /** The rail and dock of an editor, driven by the hook as the app drives it. */
  function Harness({ platform, manager }: { platform: ExtensionPlatform; manager: ExtensionsPanelOptions | undefined }): JSX.Element {
    const [sidePanel, setSidePanel] = useState<string | null>(null);
    const workspace = useExtensionWorkspace({ platform, runs: null, tabs: null, ownerId: 'u1', active: tab, openTabs: ['tab-1'], sidePanel,
      openPanel: setSidePanel, closePanel: () => setSidePanel(null), manager });
    return <>
      <SideRail items={workspace.railItems} active={workspace.shown ? sidePanel : null} onToggle={(id) => workspace.toggleRail(id as ExtensionWorkspaceRailId)} />
      {workspace.panel}
    </>;
  }
  const rail = () => screen.getByRole('navigation', { name: 'Left menu bar' });
  const labels = () => within(rail()).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
  const offered = (offered: boolean | null): ExtensionsPanelOptions => ({ offered, available: true, developerModeOn: false });
  afterEach(() => localStorage.clear());

  it('is last, after the extensions, only once the account is known to be offered extensions', async () => {
    const { platform } = await setup();
    const view = render(<Harness platform={platform} manager={undefined} />);
    expect(labels()).toEqual(['Parts']);
    view.rerender(<Harness platform={platform} manager={offered(null)} />);
    expect(labels()).toEqual(['Parts']);
    view.rerender(<Harness platform={platform} manager={offered(false)} />);
    expect(labels()).toEqual(['Parts']);
    view.rerender(<Harness platform={platform} manager={offered(true)} />);
    expect(labels()).toEqual(['Parts', 'Extensions']);
    const icon = within(rail()).getByRole('button', { name: 'Extensions' });
    expect(icon.className).toContain('is-end');
    expect(icon.getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles the Extensions side panel, which offers developer mode, and remembers it like an extension panel', async () => {
    const { platform } = await setup();
    render(<Harness platform={platform} manager={offered(true)} />);
    const icon = within(rail()).getByRole('button', { name: 'Extensions' });
    fireEvent.click(icon);
    const panel = screen.getByRole('region', { name: 'Extensions side panel' });
    expect(icon.getAttribute('aria-pressed')).toBe('true');
    expect(within(panel).getByText('The extension directory is coming soon.')).toBeTruthy();
    expect(within(panel).getByRole('checkbox', { name: 'Parts turned on' })).toBeTruthy();
    expect(within(panel).getByRole('checkbox', { name: 'Allow unsigned extensions on this device' })).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem(PANEL_KEY)).toBe('extensions'));
    // An extension's icon replaces it; the Extensions icon replaces that again.
    fireEvent.click(within(rail()).getByRole('button', { name: 'Parts' }));
    expect(screen.queryByRole('region', { name: 'Extensions side panel' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Parts side panel' })).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem(PANEL_KEY)).toBe('com.example.parts'));
    fireEvent.click(icon);
    expect(screen.queryByRole('region', { name: 'Parts side panel' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Extensions side panel' })).toBeTruthy();
    fireEvent.click(icon);
    expect(screen.queryByRole('region', { name: 'Extensions side panel' })).toBeNull();
    expect(icon.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(localStorage.getItem(PANEL_KEY)).toBeNull());
  });

  it('restores the remembered Extensions panel once the account is known to be offered extensions, and not otherwise', async () => {
    const { platform } = await setup();
    localStorage.setItem(PANEL_KEY, 'extensions');
    const view = render(<Harness platform={platform} manager={offered(null)} />);
    expect(screen.queryByRole('region', { name: 'Extensions side panel' })).toBeNull();
    view.rerender(<Harness platform={platform} manager={offered(true)} />);
    expect(await screen.findByRole('region', { name: 'Extensions side panel' })).toBeTruthy();
    expect(within(rail()).getByRole('button', { name: 'Extensions' }).getAttribute('aria-pressed')).toBe('true');
    view.unmount();
    localStorage.setItem(PANEL_KEY, 'extensions');
    render(<Harness platform={platform} manager={offered(false)} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('region', { name: 'Extensions side panel' })).toBeNull();
    expect(within(rail()).queryByRole('button', { name: 'Extensions' })).toBeNull();
  });
});
