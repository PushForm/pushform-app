// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import type { DocumentUnits, ExtensionContext, ModelDocumentSnapshot, ModelRefInput, UiNode } from '@pushform/extension-sdk';
import { TEST_DOCUMENT_UNITS, createTestHost } from './harness.ts';

/** A small extension written against the SDK alone, as a publisher would. */
const counter = {
  async activate(context: ExtensionContext) {
    const settings = context.settings!;
    let count = Number((await settings.get()).count ?? 0);
    let seq = 0;
    const view = (): UiNode => ({ type: 'stack', id: 'root', children: [
      { type: 'text', id: 'count', text: `Pressed ${count} times` },
      { type: 'button', id: 'add', label: 'Add one' },
    ] });
    context.commands.register('com.example.counter.panel', async () => {
      await context.ui.mount({ target: 'com.example.counter.panel', seq: ++seq, tree: view() });
    });
    context.ui.onEvent(async (event) => {
      if (event.event !== 'press' || event.component !== 'add') return;
      count++;
      await settings.set({ value: { count } });
      await context.clipboard!.write({ text: String(count) });
      await context.log.write({ count });
      await context.ui.update({ target: 'com.example.counter.panel', seq: ++seq, tree: view() });
    });
  },
};

const manifest = {
  id: 'com.example.counter', name: 'Counter', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling' as const],
  defaultLocale: 'en', license: 'MIT', permissions: ['settings' as const, 'clipboard.write' as const],
  contributions: [{ target: 'model.panel' as const, id: 'com.example.counter.panel', name: 'Counter' }],
  settings: { version: 1, schema: {}, defaults: { count: 0 } },
};

describe('createTestHost', () => {
  it('runs an extension through the real lifecycle, interface, settings and clipboard hosts', async () => {
    const host = await createTestHost({ manifest, module: counter });
    await host.invoke('com.example.counter.panel');
    expect(host.tree('com.example.counter.panel')).toMatchObject({ children: [{ text: 'Pressed 0 times' }, { id: 'add' }] });
    expect(host.press('com.example.counter.panel', 'add')).toBe(true);
    await vi.waitFor(() => expect(host.tree('com.example.counter.panel')).toMatchObject({ children: [{ text: 'Pressed 1 times' }, {}] }));
    expect(host.clipboard).toEqual([{ text: '1' }]);
    expect(host.logs).toEqual([{ count: 1 }]);
    expect(host.press('com.example.counter.panel', 'missing')).toBe(false);
    await host.close();
    expect(host.session.state).toBe('stopped');
  });

  it('applies grants, so missing permissions fail as they would in PushForm', async () => {
    const host = await createTestHost({ manifest, module: counter, grants: ['clipboard.write'] });
    await expect(host.session.activate()).rejects.toMatchObject({ code: 'permission.denied', details: { permissions: ['settings'] } });
  });
});

/** A parts list written against the SDK: it reads the model and units, selects and frames parts, and follows changes. */
const parts = {
  activate(context: ExtensionContext) {
    const seen: { units: DocumentUnits[]; names: string[]; changes: number[] } = { units: [], names: [], changes: [] };
    context.document.onUnitsChange((event) => seen.units.push(event.units));
    context.document.onChange((event) => seen.names.push(event.name));
    context.model!.onChange((event) => seen.changes.push(event.revision));
    context.commands.register('com.example.parts.panel', async (_params, { document }) => {
      const snapshot = await context.model!.read({});
      const units = await context.document.units({ document });
      const info = await context.document.info({ document });
      const query = await context.model!.query({ kinds: ['instance'] });
      const refs: ModelRefInput[] = query.entities.map((e) => ({ kind: 'instance', id: e.ref.id }));
      const selected = await context.selection!.set({ refs });
      await context.selection!.frame({ refs });
      const applied = await context.model!.apply({ expectedRevision: snapshot.revision, label: 'Name parts',
        operations: [{ op: 'rename_instance', ref: refs[0]!, name: 'Shelf' }] });
      await context.model!.subscribe();
      return { revision: snapshot.revision, units, info, selected: selected.refs, applied: applied.label, seen };
    });
  },
};

const partsManifest = {
  ...manifest, id: 'com.example.parts', name: 'Parts',
  permissions: ['model.read' as const, 'model.write' as const, 'selection.read' as const, 'selection.write' as const, 'viewport.presentation' as const],
  contributions: [{ target: 'model.panel' as const, id: 'com.example.parts.panel', name: 'Parts' }],
};

describe('createTestHost with a document', () => {
  const snapshot = { revision: 7 } as ModelDocumentSnapshot;
  const fakeModel = () => {
    let selection: { path: number[]; kind: 'instance'; id: number }[] = [];
    return {
      revision: 7,
      getDocument: () => snapshot,
      query: vi.fn(() => ({ revision: 7, container: [], worldTransform: [], total: 1, offset: 0, next: null,
        entities: [{ ref: { path: [], kind: 'instance' as const, id: 3 }, hidden: false }] })),
      apply: vi.fn(async (batch: unknown) => ({ ok: true as const, revision: 8, label: `Parts: ${(batch as { label: string }).label}`, created: {}, results: [] })),
      selection: () => selection,
      select: vi.fn((refs: readonly ModelRefInput[]) => (selection = refs.map((r) => ({ path: [], kind: 'instance' as const, id: (r as { id: number }).id })))),
      frame: vi.fn(() => null),
    };
  };

  it('serves the model, selection and units of the document, through the real document services', async () => {
    const model = fakeModel();
    const host = await createTestHost({ manifest: partsManifest, module: parts, document: { model, name: 'Bookcase' } });
    const result = await host.invoke('com.example.parts.panel') as Record<string, unknown>;
    expect(result).toMatchObject({ revision: 7, units: { system: 'metric', lengthUnit: 'mm', format: 'decimal', lengthPrecision: 1 },
      info: { name: 'Bookcase', units: TEST_DOCUMENT_UNITS }, selected: [{ path: [], kind: 'instance', id: 3 }], applied: 'Parts: Name parts' });
    expect(model.query).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['instance'], container: null, limit: null }));
    expect(model.frame).toHaveBeenCalledWith([{ kind: 'instance', id: 3 }]);
    const inches: DocumentUnits = { system: 'imperial', lengthUnit: 'in', format: 'fractional', lengthPrecision: 3 };
    host.document!.setUnits(inches);
    host.document!.setName('Bookcase v2');
    host.document!.changed('model');
    await new Promise((resolve) => setTimeout(resolve, 20)); // changes are coalesced before they are sent
    const again = await host.invoke('com.example.parts.panel') as { info: unknown; seen: { units: DocumentUnits[]; names: string[]; changes: number[] } };
    // Told of the document's name and units when the first invocation started acting on it, then of each change.
    expect(again.seen.units).toEqual([TEST_DOCUMENT_UNITS, inches]);
    expect(again.seen.names).toEqual(['Bookcase', 'Bookcase', 'Bookcase v2']);
    expect(again.info).toEqual({ name: 'Bookcase v2', units: inches });
    expect(again.seen.changes).toEqual([7]);
    host.document!.close();
    await expect(host.invoke('com.example.parts.panel', {}, { document: 'test-document' })).rejects.toMatchObject({ code: 'document.closed' });
    await host.close();
  });

  it('applies grants to the document services', async () => {
    const host = await createTestHost({ manifest: partsManifest, module: parts, document: { model: fakeModel() }, grants: ['model.read', 'selection.read'] });
    await expect(host.invoke('com.example.parts.panel')).rejects.toMatchObject({ code: 'permission.denied', details: { permission: 'selection.write' } });
    await host.close();
  });
});

/** A sidebar with a button that opens the extension's full panel tab, written against the SDK. */
const opener = {
  activate(context: ExtensionContext) {
    context.commands.register('com.example.opener.side', async () => {
      await context.ui.mount({ target: 'com.example.opener.side', seq: 1, tree: { type: 'button', id: 'open', label: 'Open the full list' } });
    });
    context.commands.register('com.example.opener.panel', async () => {
      await context.ui.mount({ target: 'com.example.opener.panel', seq: 1, tree: { type: 'text', id: 't', text: 'The full list' } });
    });
    context.ui.onEvent(async (event) => {
      if (event.component === 'open') await context.ui.open({ target: 'com.example.opener.panel' });
    });
  },
};

describe('createTestHost with sidebar and panel targets', () => {
  const manifest = {
    id: 'com.example.opener', name: 'Opener', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling' as const],
    defaultLocale: 'en', license: 'MIT', permissions: [], icon: 'saw-blade',
    contributions: [
      { target: 'model.sidebar' as const, id: 'com.example.opener.side', name: 'Opener' },
      { target: 'model.panel' as const, id: 'com.example.opener.panel', name: 'Full list' },
      { target: 'model.toolbar' as const, id: 'com.example.opener.button', name: 'Open the list', category: 'inspect' as const, icon: 'saw-blade' },
    ],
  };

  it('mounts a sidebar and records the panel tabs the extension asks to open', async () => {
    const host = await createTestHost({ manifest, module: opener, document: {} });
    await host.invoke('com.example.opener.side');
    expect(host.tree('com.example.opener.side')).toMatchObject({ label: 'Open the full list' });
    expect(host.press('com.example.opener.side', 'open')).toBe(true);
    await vi.waitFor(() => expect(host.opened).toEqual([{ extensionId: 'com.example.opener', target: 'com.example.opener.panel', documentId: 'test-document' }]));
    // Opening the tab runs the panel contribution, as PushForm would.
    await host.invoke(host.opened[0]!.target);
    expect(host.tree('com.example.opener.panel')).toMatchObject({ text: 'The full list' });
    await host.close();
  });
});
