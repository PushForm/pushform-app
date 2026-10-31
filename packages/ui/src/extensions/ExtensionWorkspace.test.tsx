// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { zipSync } from 'fflate';
import { CommandRegistry, MemoryTransactionHost } from '@pushform/commands';
import { DEFAULT_UNITS } from '@pushform/core';
import { buildManifest, type ExtensionManifestInput } from '@pushform/extension-protocol';
import {
  ExtensionPlatform, memoryDeveloperMode, memoryExtensionStore, memorySettingsStore, messagePortTransport, startGuest, type ExtensionContext,
} from '@pushform/extensions';
import { searchCommands } from '../components/CommandSearch';
import { ExtensionActivity, ExtensionRuns } from './ExtensionActivity';
import { ExtensionPanel } from './ExtensionPanel';
import { extensionPanels, selectionActionGroups, syncExtensionCommands } from './extensionContributions';

const encode = (s: string) => new TextEncoder().encode(s);
const manifest = {
  id: 'com.example.parts', name: 'Parts', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'],
  defaultLocale: 'en', license: 'MIT', permissions: [],
  contributions: [
    { target: 'model.panel', id: 'com.example.parts.panel', name: 'Parts list' },
    { target: 'model.command', id: 'com.example.parts.export', name: 'Export parts' },
    { target: 'model.selection.action', id: 'com.example.parts.label', name: 'Label selected parts' },
  ],
} satisfies Omit<ExtensionManifestInput, 'files'>;

const channels: MessageChannel[] = [];
afterEach(() => { cleanup(); for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

/** A platform with the Parts extension installed, running `module` in this process. */
async function setup(module: unknown = { activate() {} }) {
  const terminated: string[] = [];
  const platform = new ExtensionPlatform({
    store: memoryExtensionStore(), developerMode: memoryDeveloperMode(true), settingsStore: () => memorySettingsStore(),
    startRuntime: async () => {
      const channel = new MessageChannel();
      channels.push(channel);
      void startGuest(messagePortTransport(channel.port2), async () => module);
      return { port: messagePortTransport(channel.port1), terminate: () => terminated.push('parts') };
    },
  });
  const files = new Map<string, Uint8Array>([['main.js', encode('export function activate() {}')]]);
  files.set('manifest.json', await buildManifest(manifest, files));
  await platform.install(await platform.sideload(zipSync(Object.fromEntries(files))), []);
  return { platform, terminated };
}

const registry = () => new CommandRegistry({ tx: new MemoryTransactionHost(), services: new Map() });

describe('extension commands', () => {
  it('appear in command search and the selection menu under the extension name, and leave when it is turned off', async () => {
    const { platform } = await setup();
    const commands = registry();
    const ran: string[] = [];
    const stop = syncExtensionCommands(commands, platform, 'modeling', (entry) => ran.push(entry.id));
    expect(searchCommands(commands, null, 'export')).toEqual([expect.objectContaining({ id: 'extension:com.example.parts.export', title: 'Export parts', source: 'Parts' })]);
    // The extension's name finds its commands too.
    expect(searchCommands(commands, null, 'parts').map((i) => i.id)).toContain('extension:com.example.parts.label');
    expect(selectionActionGroups(commands)).toEqual([
      expect.objectContaining({ label: 'Parts', children: [expect.objectContaining({ label: 'Label selected parts', command: 'extension:com.example.parts.label' })] }),
    ]);
    await commands.execute('extension:com.example.parts.export', {});
    expect(ran).toEqual(['com.example.parts.export']);
    // Registering ran no extension code.
    expect(platform.state('com.example.parts')!.run).toBe('stopped');

    await platform.setEnabled('com.example.parts', false);
    expect(commands.has('extension:com.example.parts.export')).toBe(false);
    expect(extensionPanels(platform, 'modeling')).toEqual([]);
    await platform.setEnabled('com.example.parts', true);
    expect(commands.has('extension:com.example.parts.export')).toBe(true);
    // An editor the extension does not support gets none of it.
    const layout = registry();
    syncExtensionCommands(layout, platform, 'layout', () => {});
    expect(layout.list().filter((c) => c.id.startsWith('extension:'))).toEqual([]);
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
    render(<ExtensionActivity runs={runs} />);
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

describe('extension panels', () => {
  it('opens in a PushForm frame naming the extension, shows its interface, and removes it when closed', async () => {
    const { platform } = await setup({
      activate(context: ExtensionContext) {
        const ui = context.ui as { mount(i: unknown): Promise<unknown> };
        context.commands.register('com.example.parts.panel', () =>
          ui.mount({ target: 'com.example.parts.panel', seq: 1, tree: { type: 'text', id: 't', text: '12 parts' } }));
      },
    });
    const [entry] = extensionPanels(platform, 'modeling');
    const view = render(<ExtensionPanel platform={platform} entry={entry!} units={DEFAULT_UNITS} documentId='tab-1' onClose={() => {}} />);
    const frame = screen.getByRole('region', { name: 'Parts list, from Parts' });
    expect(frame.textContent).toContain('Unsigned (developer)');
    expect(await screen.findByText('12 parts')).toBeTruthy();
    expect(platform.ui('com.example.parts')!.get('com.example.parts.panel')).toBeTruthy();
    view.unmount();
    expect(platform.ui('com.example.parts')!.get('com.example.parts.panel')).toBeUndefined();
  });

  it('says when the extension fails to open it', async () => {
    const { platform } = await setup({
      activate(context: ExtensionContext) {
        context.commands.register('com.example.parts.panel', () => { throw new Error('No model open'); });
      },
    });
    const [entry] = extensionPanels(platform, 'modeling');
    render(<ExtensionPanel platform={platform} entry={entry!} units={DEFAULT_UNITS} documentId='tab-1' onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/No model open/));
  });
});
