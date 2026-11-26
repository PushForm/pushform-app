// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { zipSync } from 'fflate';
import { buildManifest } from '@pushform/extension-protocol';
import { ExtensionPlatform, memoryDeveloperMode, memoryExtensionStore, memorySettingsStore, messagePortTransport, startGuest } from '@pushform/extensions';
import type { ExtensionContext } from '@pushform/extensions';
import type { InspectorCapture } from '@pushform/extension-protocol';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { createApp, type AppInstance } from '../bootstrap';
import { AppContext } from '../AppContext';
import { EntityInfoPanel } from '../panels/EntityInfoPanel';
import { ExtensionInspectorContext } from './ExtensionInspectors';
import { inspectorPlacementCount, inspectorTargets } from './inspectorSelection';

const channels: MessageChannel[] = [], apps: AppInstance[] = [];
afterEach(() => { cleanup(); localStorage.clear(); for (const app of apps.splice(0)) app.dispose(); for (const channel of channels.splice(0)) { channel.port1.close(); channel.port2.close(); } });
const id = 'com.example.parts', target = `${id}.inspector`;
async function setup() {
  const app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) }); apps.push(app);
  const body = app.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
  app.document.selection.set([{ kind: 'body', path: [], id: body as never }]);
  const captures: InspectorCapture[] = [];
  const platform = new ExtensionPlatform({ store: memoryExtensionStore(), developerMode: memoryDeveloperMode(true), settingsStore: () => memorySettingsStore(),
    startRuntime: async () => {
      const channel = new MessageChannel(); channels.push(channel);
      void startGuest(messagePortTransport(channel.port2), async () => ({ activate(context: unknown) {
        const c = context as ExtensionContext;
        c.commands.register(target, async params => {
          const capture = (params as { inspector: InspectorCapture }).inspector; captures.push(capture);
          await (c.ui as { mount(input: unknown): Promise<unknown> }).mount({ target, binding: capture.binding, seq: 1, tree: { type: 'stack', id: 'fields', children: [
            { type: 'textField', id: 'label', label: 'Manufacturing label', value: 'Door' }, { type: 'text', id: 'source', text: 'From material: Maple' },
          ] } });
        });
      } }));
      return { port: messagePortTransport(channel.port1), terminate() {} };
    },
  });
  const files = new Map<string, Uint8Array>([['main.js', new TextEncoder().encode('export function activate() {}')]]);
  files.set('manifest.json', await buildManifest({ id, name: 'Parts', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'], defaultLocale: 'en', license: 'MIT', permissions: ['model.read', 'model.write', 'selection.read'],
    metadata: { dataVersion: 1, schema: { type: 'object', properties: { label: { type: 'string' } } } },
    contributions: [{ target: 'model.inspector.block', id: target, name: 'Part properties', inspector: { targets: ['bodyOccurrence', 'body'], multiSelection: 'mixed' } }],
  }, files));
  await platform.install(await platform.sideload(zipSync(Object.fromEntries(files))), ['model.read', 'model.write', 'selection.read']);
  const mount = () => render(<AppContext.Provider value={app}><ExtensionInspectorContext.Provider value={{ platform, documentId: 'tab-1', ownerId: 'tester' }}><EntityInfoPanel /></ExtensionInspectorContext.Provider></AppContext.Provider>);
  const attach = (dataVersion: number) => app.document.doc.transact('Saved metadata', draft => { draft.pluginData = new Map([[id, { dataVersion, entries: new Map([['part', { target: { kind: 'bodyOccurrence', id: body, path: [] }, references: [], payload: new Uint8Array([255, 0]) }]]) }]]); });
  return { app, body, platform, captures, mount, attach };
}

it('keeps core properties first, starts a plugin only when expanded and captures scope and revision', async () => {
  const s = await setup(); s.mount();
  expect(s.captures).toHaveLength(0);
  expect(screen.getByText('Solid Body').compareDocumentPosition(screen.getByText('Parts')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByText('Parts'));
  await screen.findByLabelText('Manufacturing label');
  expect(s.captures[0]).toMatchObject({ scope: 'placement', revision: s.app.document.doc.version, targets: [{ kind: 'bodyOccurrence', id: s.body, path: [] }] });
  fireEvent.change(screen.getByLabelText('Parts edit scope'), { target: { value: 'shared' } });
  await waitFor(() => expect(s.captures.at(-1)!.scope).toBe('shared'));
  expect(s.captures.at(-1)!.targets).toEqual([{ kind: 'body', id: s.body }]);
  expect(s.captures.at(-1)!.binding).not.toBe(s.captures[0]!.binding);
  expect(screen.queryByText(/Manage extensions/i)).toBeNull();
});

it('reveals a collapsed inspector in placement scope with a fresh capture', async () => {
  const s = await setup();
  const view = s.mount(); fireEvent.click(screen.getByText('Parts')); await screen.findByLabelText('Manufacturing label');
  fireEvent.change(screen.getByLabelText('Parts edit scope'), { target: { value: 'shared' } });
  await waitFor(() => expect(s.captures.at(-1)!.scope).toBe('shared'));
  fireEvent.click(screen.getByText('Parts'));
  await waitFor(() => expect(screen.queryByLabelText('Manufacturing label')).toBeNull());
  view.rerender(<AppContext.Provider value={s.app}><ExtensionInspectorContext.Provider value={{ platform: s.platform, documentId: 'tab-1', ownerId: 'tester', reveal: { target, seq: 1 } }}><EntityInfoPanel /></ExtensionInspectorContext.Provider></AppContext.Provider>);
  await screen.findByLabelText('Manufacturing label');
  expect(s.captures.at(-1)!.scope).toBe('placement');
  expect((screen.getByLabelText('Parts edit scope') as HTMLSelectElement).value).not.toBe('shared');
});

it('revokes the old inspector binding on selection changes and collapse', async () => {
  const s = await setup(); s.mount(); fireEvent.click(screen.getByText('Parts')); await screen.findByLabelText('Manufacturing label');
  const first = s.captures[0]!.binding;
  act(() => { s.app.commands.execute('model.addBox', { min: [2, 0, 0], max: [3, 1, 1] }); });
  await waitFor(() => expect(s.captures.length).toBeGreaterThan(1));
  expect(() => s.platform.ui(id)!.inspectorBinding(first, 'tab-1')).toThrow(/changed/);
  const revisionBinding = s.captures.at(-1)!.binding;
  const other = [...s.app.document.doc.rootDefinition.entities.bodies.keys()].find(id => id !== s.body)!;
  act(() => { s.app.document.selection.set([{ kind: 'body', path: [], id: other }]); });
  await waitFor(() => expect(s.captures.at(-1)!.targets).toEqual([{ kind: 'bodyOccurrence', id: other, path: [] }]));
  expect(() => s.platform.ui(id)!.inspectorBinding(revisionBinding, 'tab-1')).toThrow(/changed/);
  const current = s.captures.at(-1)!.binding;
  fireEvent.click(screen.getByText('Parts'));
  await waitFor(() => expect(screen.queryByLabelText('Manufacturing label')).toBeNull());
  expect(() => s.platform.ui(id)!.inspectorBinding(current, 'tab-1')).toThrow(/changed/);
});

it('keeps newer saved data read-only and never starts an older plugin with editable defaults', async () => {
  const s = await setup(); s.attach(2); s.mount(); fireEvent.click(screen.getByText('Parts'));
  expect(await screen.findByText(/contains newer plugin data/)).toBeTruthy();
  expect(s.captures).toHaveLength(0);
  expect(screen.queryByLabelText('Manufacturing label')).toBeNull();
});

it('expands selected assemblies into solid parts, counts repeated placements and blocks partial unsupported batches', async () => {
  const s = await setup();
  const group = s.app.commands.execute('group.make', { refs: [{ kind: 'body', path: [], id: s.body }] }) as { instanceId: number };
  const copy = await s.app.commands.execute('transform.apply', { refs: [{ kind: 'instance', path: [], id: group.instanceId }], matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1], copy: true }) as { refs: { id: number }[] };
  const declaration = { targets: ['bodyOccurrence', 'body'] as ('bodyOccurrence' | 'body')[], multiSelection: 'mixed' as const };
  const refs = [{ kind: 'instance' as const, path: [], id: group.instanceId as never }];
  const selection = inspectorTargets(s.app.document.doc.state, refs, declaration, 'placement');
  expect(selection.targets).toEqual([{ kind: 'bodyOccurrence', id: s.body, path: [group.instanceId] }]);
  expect(inspectorPlacementCount(s.app.document.doc.state, selection.targets)).toBe(2);
  const both = inspectorTargets(s.app.document.doc.state, [...refs, { kind: 'instance', path: [], id: copy.refs[0]!.id as never }], declaration, 'shared');
  expect(both.targets).toEqual([{ kind: 'body', id: s.body }]);
  const unsupported = inspectorTargets(s.app.document.doc.state, [...refs, { kind: 'sketchEdge', path: [], id: 999 as never }], declaration, 'placement');
  expect(unsupported.unsupported).toBe(1);
});

it('offers contextual enable for a disabled plugin while retaining its opaque saved data', async () => {
  const s = await setup(); s.attach(1); await s.platform.setEnabled(id, false); s.mount();
  expect(screen.getByText(/Properties are saved with this model/)).toBeTruthy();
  expect(s.captures).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Enable Parts' }));
  await waitFor(() => expect(s.platform.state(id)!.record.enabled).toBe(true));
  expect(s.app.document.doc.state.pluginData!.get(id)!.entries.get('part')!.payload).toEqual(new Uint8Array([255, 0]));
  expect(s.captures).toHaveLength(0);
});
