// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './bootstrap';
import { DocumentSession } from './session';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { layoutContentIdentity, openLayoutFile, openModelFile, readSketchUp, type LayoutRecoveryRecord, type LayoutRecoveryStore } from '@pushform/io';
import { meshBox } from '@pushform/core';
import { bodyFromMesh } from '@pushform/model';
import { entitiesForLayer } from '@pushform/layout';

class MemoryRecoveryStore implements LayoutRecoveryStore {
  records = new Map<string, LayoutRecoveryRecord>();
  async list(): Promise<LayoutRecoveryRecord[]> { return [...this.records.values()]; }
  async read(id: string): Promise<LayoutRecoveryRecord | undefined> { return this.records.get(id); }
  async put(record: LayoutRecoveryRecord): Promise<void> { this.records.set(record.id, record); }
  async delete(id: string): Promise<void> { this.records.delete(id); }
}

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

let session: DocumentSession | null = null;
afterEach(() => {
  session?.dispose();
  session = null;
});

describe('DocumentSession', () => {
  it('keeps model and layout document histories isolated across tabs', () => {
    const first = createApp({ demo: false, expose: false });
    session = new DocumentSession(first, () => createApp({ demo: false, expose: false }), true);
    const modelId = session.activeId;
    const layout = session.newLayout();
    const page = layout.doc.addPage();
    expect(layout.doc.state.pages.has(page)).toBe(true);
    const second = session.newModel();
    second.app.document.edit('Rename root', (draft) => {
      draft.definitions.get(draft.rootDefinitionId)!.name = 'Second model';
    });
    expect(session.activate(modelId)).toBe(true);
    expect(first.document.doc.rootDefinition.name).toBe('Model');
    expect(session.activate(layout.id)).toBe(true);
    expect(layout.doc.undoStack.undo()).toBe(true);
    expect(layout.doc.state.pages.has(page)).toBe(false);
    expect(session.isDirty(layout)).toBe(false);
    expect(second.app.document.doc.rootDefinition.name).toBe('Second model');
    expect(second.app.document.canUndo()).toBe(true);
  });

  it('routes scripts to the active Layout tab for a snapped 100 mm line and page undo', () => {
    session = new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
    );
    const model = session.active;
    expect(model.type).toBe('model');
    if (model.type !== 'model') return;
    const modelVersion = model.app.document.doc.version;
    const layout = session.newLayout();
    const pageId = layout.activePageId;
    expect(session.scripts.run([{ cmd: 'layout.shape.add', params: {
      pageId, points: [[10, 20], [110, 20]], closed: false,
    } }])[0]?.ok).toBe(true);
    const drawn = session.scripts.run([{ cmd: 'layout.shape.add', params: {
      pageId,
      points: [[59.8, 20.2], [159.8, 20.2]],
      snapStartToleranceMm: 1,
    } }]);
    expect(drawn[0]?.ok).toBe(true);
    const line = layout.doc.state.pages.get(pageId)?.entities.get(drawn[0]?.result as number);
    expect(line?.points).toEqual([[60, 20], [160, 20]]);
    expect(Math.hypot(line!.points[1]![0] - line!.points[0]![0],
      line!.points[1]![1] - line!.points[0]![1])).toBe(100);

    expect(session.scripts.run([{ cmd: 'layout.page.add' }])[0]?.ok).toBe(true);
    expect(layout.doc.state.pageOrder).toHaveLength(2);
    expect(session.scripts.run([{ cmd: 'edit.undo' }])[0]?.ok).toBe(true);
    expect(layout.doc.state.pageOrder).toHaveLength(1);
    expect(model.app.document.doc.version).toBe(modelVersion);

    session.activate(model.id);
    expect(session.scripts.run([{ cmd: 'layout.page.add' }])[0]?.ok).toBe(false);
    expect(layout.doc.state.pageOrder).toHaveLength(1);
  });

  it('requires explicit discard for a dirty tab and activates a neighbor on close', () => {
    session = new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
    );
    const modelId = session.activeId;
    const layout = session.newLayout();
    layout.doc.addPage();
    expect(session.close(layout.id)).toBe(false);
    expect(session.activeId).toBe(layout.id);
    expect(session.close(layout.id, true)).toBe(true);
    expect(session.activeId).toBe(modelId);
    expect(session.tabs).toHaveLength(1);
  });

  it('opens a saved Layout once per identity and tracks saved content', async () => {
    session = new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
    );
    const first = session.newLayout();
    first.commands.execute('layout.shape.add', {
      pageId: first.activePageId,
      points: [
        [0, 0],
        [100, 0],
      ],
      closed: false,
    });
    expect(session.isDirty(first)).toBe(true);
    const bytes = (await session.saveLayoutBytes(first.id, 'Drawing.pfl', 'asset-1'));
    expect(session.isDirty(first)).toBe(false);
    expect((await session.openLayoutBytes(bytes, 'Drawing.pfl', 'asset-1')).id).toBe(first.id);
    expect(session.tabs).toHaveLength(2);
    const copy = (await session.openLayoutBytes(bytes, 'Drawing Copy.pfl', 'asset-2'));
    expect(copy.doc.state.pages.get(copy.activePageId)?.entities.size).toBe(1);
    expect(session.isDirty(copy)).toBe(false);
    const writtenContent = layoutContentIdentity(copy.doc.state);
    copy.commands.execute('layout.page.add');
    session.markLayoutSaved(copy.id, undefined, undefined, writtenContent);
    expect(session.isDirty(copy)).toBe(true);
  });

  it('saves and reopens a Modeling file once per identity, including undo dirty tracking', async () => {
    session = new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
    );
    const original = session.active;
    expect(original.type).toBe('model');
    if (original.type !== 'model') return;
    original.app.document.edit('Add box', (draft) => {
      bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), {
        container: draft.definitions.get(draft.rootDefinitionId)!.entities,
      });
    });
    const bytes = await session.saveModelBytes(original.id, 'Building.pf', '/models/building.pf');
    expect(session.isDirty(original)).toBe(false);
    expect((await session.openModelBytes(bytes, 'Building.pf', '/models/building.pf')).id).toBe(original.id);
    expect(session.tabs).toHaveLength(1);

    const copy = await session.openModelBytes(bytes, 'Copy.pf', '/models/copy.pf');
    expect(copy.app.bodies).toHaveLength(1);
    expect(session.isDirty(copy)).toBe(false);
    copy.app.document.edit('Rename root', (draft) => {
      draft.definitions.get(draft.rootDefinitionId)!.name = 'Changed';
    });
    expect(session.isDirty(copy)).toBe(true);
    expect(copy.app.document.undo()).toBe(true);
    expect(session.isDirty(copy)).toBe(false);
  });

  it('opens a SketchUp model with its display units; importing it keeps the destination units', async () => {
    session = new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
    );
    const destination = session.active;
    if (destination.type !== 'model') throw new Error('expected a model tab');
    const before = destination.app.document.doc.state.meta.units;
    const bytes = readFileSync(resolve(__dirname, '../../testing/assets/sketchup/units-decimal-2027.skp'));
    const scene = await readSketchUp(bytes);
    const { tab } = session.openSketchUpModel(scene, 'Units.skp');
    expect(tab.app.document.doc.state.meta.units).toMatchObject({ format: 'decimal', lengthUnit: 'mm', lengthPrecision: 1 });
    session.importSketchUpModel(scene, 'Units.skp', destination.id, destination.app.document.doc.state.rootDefinitionId);
    expect(destination.app.document.doc.state.meta.units).toEqual(before);
  });

  it('saves the captured Layout revision and installs concurrent opens only once', async () => {
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true);
    const tab = session.newLayout(), pageId = tab.activePageId;
    const before = tab.doc.state.pages.get(pageId)!.name;
    const saving = session.saveLayoutBytes(tab.id, 'Captured.pfl');
    tab.doc.renamePage(pageId, 'Later');
    const bytes = await saving;
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('PUSHFRM2');
    expect((await openLayoutFile(bytes)).state.pages.get(pageId)!.name).toBe(before);
    expect(session.isDirty(tab)).toBe(true);
    tab.commands.execute('edit.undo');
    expect(session.isDirty(tab)).toBe(false);
    const closingSave = session.saveLayoutBytes(tab.id);
    session.close(tab.id, true);
    await expect(closingSave).resolves.toBeInstanceOf(Uint8Array);
    const [first, second] = await Promise.all([
      session.openLayoutBytes(bytes, 'Shared.pfl', 'shared-layout'),
      session.openLayoutBytes(bytes, 'Shared.pfl', 'shared-layout'),
    ]);
    expect(second).toBe(first);
    expect(session.tabs.filter(item => item.identity === 'shared-layout')).toHaveLength(1);
  });

  it('saves the captured model revision while later edits remain dirty', async () => {
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true);
    const tab = session.active;
    if (tab.type !== 'model') throw new Error('expected model');
    const name = tab.app.document.doc.rootDefinition.name;
    const saving = session.saveModelBytes(tab.id, 'Captured.pf');
    tab.app.document.edit('Later edit', draft => { draft.definitions.get(draft.rootDefinitionId)!.name = 'Later'; });
    const bytes = await saving;
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('PUSHFRM2');
    const opened = await openModelFile(bytes);
    expect(opened.state.definitions.get(opened.state.rootDefinitionId)!.name).toBe(name);
    expect(session.isDirty(tab)).toBe(true);
    tab.app.document.undo();
    expect(session.isDirty(tab)).toBe(false);
  });

  it('finishes a captured model download after its tab closes and deduplicates concurrent opens', async () => {
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true);
    const id = session.activeId, saving = session.saveModelBytes(id);
    session.newLayout();
    session.close(id, true);
    const bytes = await saving;
    expect(session.tabs.some(tab => tab.id === id)).toBe(false);
    const [first, second] = await Promise.all([
      session.openModelBytes(bytes, 'Shared.pf', 'shared'),
      session.openModelBytes(bytes, 'Shared.pf', 'shared'),
    ]);
    expect(second).toBe(first);
    expect(session.tabs.filter(tab => tab.identity === 'shared')).toHaveLength(1);
  });

  it('keeps a saved Modeling file identity across refresh', async () => {
    const storage = new MemoryStorage();
    const makeSession = () => new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
      null,
      storage,
    );
    session = makeSession();
    const model = session.active;
    const bytes = await session.saveModelBytes(model.id, 'House.pf', '/projects/House.pf');
    session.dispose();

    session = makeSession();
    expect(session.tabs).toHaveLength(1);
    const restoredId = session.activeId;
    expect((await session.openModelBytes(bytes, 'House.pf', '/projects/House.pf')).id).toBe(restoredId);
    expect(session.tabs).toHaveLength(1);
  });

  it('recovers an unsaved Layout across sessions and removes the draft after save', async () => {
    const store = new MemoryRecoveryStore();
    session = new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
      store,
    );
    const tab = session.newLayout();
    tab.commands.execute('layout.shape.add', {
      pageId: tab.activePageId,
      points: [[0, 0], [100, 0]],
      closed: false,
    });
    await session.flushLayoutRecovery();
    const [draft] = await store.list();
    expect(draft?.name).toBe(tab.name);
    expect(new TextDecoder().decode(draft!.bytes.subarray(0, 8))).toBe('PUSHFRM2');
    session.dispose();

    session = new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
      store,
    );
    const reads = vi.spyOn(store, 'read');
    const [listed] = await session.listLayoutRecoveries();
    expect(reads).not.toHaveBeenCalled();
    const restored = await session.restoreLayoutRecovery(listed!);
    expect(reads).toHaveBeenCalledExactlyOnceWith(listed!.id);
    expect(await session.restoreLayoutRecovery(listed!)).toBe(restored);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(restored.doc.state.pages.get(restored.activePageId)?.entities.size).toBe(1);
    expect(session.isDirty(restored)).toBe(true);
    (await session.saveLayoutBytes(restored.id, 'Recovered.pfl'));
    await session.flushLayoutRecovery();
    expect(await store.list()).toHaveLength(0);
    await expect(session.restoreLayoutRecovery({ ...listed!, id: 'missing' })).rejects.toThrow('no longer available');
  });

  it.each([false, true])('coalesces binary recovery revisions and orders save deletion (save=%s)', async save => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const writes: LayoutRecoveryRecord[] = [];
    class SlowStore extends MemoryRecoveryStore {
      override async put(record: LayoutRecoveryRecord): Promise<void> {
        writes.push(record);
        if (writes.length === 1) { entered(); await gate; }
        await super.put(record);
      }
    }
    const store = new SlowStore();
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, store);
    const tab = session.newLayout();
    const rename = (name: string) => tab.doc.transact('rename', d => { d.pages.get(tab.activePageId)!.name = name; });
    rename('first'); const first = session.flushLayoutRecovery(); await started;
    rename('second'); const second = session.flushLayoutRecovery();
    rename('third'); const third = session.flushLayoutRecovery();
    if (save) session.markLayoutSaved(tab.id);
    release(); await Promise.all([first, second, third]);
    expect(writes).toHaveLength(save ? 1 : 2);
    expect((await openLayoutFile(writes[0]!.bytes)).state.pages.get(tab.activePageId)!.name).toBe('first');
    if (save) expect(await store.list()).toHaveLength(0);
    else expect((await openLayoutFile(writes[1]!.bytes)).state.pages.get(tab.activePageId)!.name).toBe('third');
  });

  it('keeps the last binary recovery after a failed write and retries the next edit', async () => {
    class FailingStore extends MemoryRecoveryStore {
      fail = false;
      override async put(record: LayoutRecoveryRecord): Promise<void> {
        if (this.fail) throw new Error('quota');
        await super.put(record);
      }
    }
    const store = new FailingStore();
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, store);
    const tab = session.newLayout();
    const rename = (name: string) => tab.doc.transact('rename', d => { d.pages.get(tab.activePageId)!.name = name; });
    rename('first'); await session.flushLayoutRecovery();
    const previous = (await store.list())[0]!;
    store.fail = true; rename('failed'); await session.flushLayoutRecovery();
    expect(session.recoveryError).toBe('quota'); expect((await store.list())[0]).toBe(previous);
    store.fail = false; rename('retry'); await session.flushLayoutRecovery();
    expect((await openLayoutFile((await store.list())[0]!.bytes)).state.pages.get(tab.activePageId)!.name).toBe('retry');
  });

  it('keeps page setup and path style after save and reopen', async () => {
    session = new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
    );
    const tab = session.newLayout();
    tab.commands.execute('layout.page.setup', {
      pageId: tab.activePageId,
      widthMm: 420,
      heightMm: 297,
      marginMm: 15,
    });
    tab.commands.execute('layout.style.setDefault', { strokeColor: '#cc0000' });
    const entityId = tab.commands.execute('layout.shape.add', {
      pageId: tab.activePageId,
      points: [[10, 10], [110, 10]],
      closed: false,
    }) as number;
    tab.commands.execute('layout.shape.setStyle', {
      pageId: tab.activePageId,
      entityId,
      strokeWeightPt: 2,
    });
    const reopened = (await session.openLayoutBytes((await session.saveLayoutBytes(tab.id)), 'Styled.pfl'));
    const page = reopened.doc.state.pages.get(reopened.activePageId)!;
    expect(page.size).toEqual([420, 297]);
    expect(page.margin.left).toBe(15);
    expect(page.entities.get(entityId)?.style).toMatchObject({
      strokeColor: '#cc0000',
      strokeWeightPt: 2,
    });
  });

  it('restores the active Layout tab, page, and unsaved content after refresh', async () => {
    const storage = new MemoryStorage();
    const recoveries = new MemoryRecoveryStore();
    const makeSession = () => new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
      recoveries,
      storage,
    );
    session = makeSession();
    const first = session.newLayout();
    (await session.saveLayoutBytes(first.id, 'First.pfl'));
    const second = session.newLayout();
    second.commands.execute('layout.page.add');
    const pageId = second.doc.state.pageOrder[1]!;
    session.setActivePage(pageId);
    second.commands.execute('layout.shape.add', {
      pageId,
      points: [[0, 0], [100, 0]],
      closed: false,
    });
    await session.flushLayoutRecovery();
    expect(await recoveries.list()).toHaveLength(1);
    session.dispose();

    session = makeSession();
    expect(session.tabs).toHaveLength(3);
    expect(session.active.type).toBe('layout');
    if (session.active.type !== 'layout') return;
    expect(session.active.name).toBe(second.name);
    expect(session.active.activePageId).toBe(pageId);
    expect(session.active.doc.state.pages.get(pageId)?.entities.size).toBe(1);
    expect(session.isDirty(session.active)).toBe(true);
    expect(await session.listLayoutRecoveries()).toHaveLength(0);
    expect(session.tabs[1]?.name).toBe('First.pfl');

    expect(session.close(session.active.id, true)).toBe(true);
    session.dispose();
    session = makeSession();
    expect(session.tabs).toHaveLength(2);
    expect(session.active.type).toBe('layout');
    expect(session.active.name).toBe('First.pfl');
  });

  it('ignores an invalid refresh snapshot', () => {
    const storage = new MemoryStorage();
    storage.setItem('pushform:document-session:v2', '{bad');
    session = new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
      null,
      storage,
    );
    expect(session.active.type).toBe('model');
    expect(session.tabs).toHaveLength(1);
  });

  it('restores the active Modeling tab and its geometry after refresh', () => {
    const storage = new MemoryStorage();
    const makeSession = () => new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
      null,
      storage,
    );
    session = makeSession();
    const layout = session.newLayout();
    const model = session.newModel();
    model.app.document.edit('Rename root', (draft) => {
      const root = draft.definitions.get(draft.rootDefinitionId)!;
      root.name = 'Restored model';
      bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: root.entities });
    });
    expect(session.isDirty(model)).toBe(true);
    session.dispose();

    session = makeSession();
    expect(session.tabs).toHaveLength(3);
    expect(session.active.type).toBe('model');
    if (session.active.type !== 'model') return;
    expect(session.active.name).toBe(model.name);
    expect(session.active.app.document.doc.rootDefinition.name).toBe('Restored model');
    const body = [...session.active.app.document.doc.rootDefinition.entities.bodies.values()][0]!;
    expect(body.mesh.verts).toBeInstanceOf(Float64Array);
    expect(body.mesh.tris).toBeInstanceOf(Uint32Array);
    expect(session.active.app.bodies).toHaveLength(1);
    expect(session.isDirty(session.active)).toBe(true);
    expect(session.tabs[1]?.name).toBe(layout.name);
  });

  it('does not reopen a Modeling tab that was closed before refresh', () => {
    const storage = new MemoryStorage();
    const makeSession = () => new DocumentSession(
      createApp({ demo: false, expose: false }),
      () => createApp({ demo: false, expose: false }),
      true,
      null,
      storage,
    );
    session = makeSession();
    const modelId = session.activeId;
    const layout = session.newLayout();
    expect(session.close(modelId, true)).toBe(true);
    session.dispose();

    session = makeSession();
    expect(session.tabs).toHaveLength(1);
    expect(session.active.type).toBe('layout');
    expect(session.active.name).toBe(layout.name);
  });
});

it('starts chosen templates clean and preserves their settings and editable content across save/reopen', async () => {
  session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
  for (const templateId of ['graph-letter-portrait-div10', 'plain-a4-portrait', 'storyboard-3x2', 'titleblock-a3']) {
    const tab = session.newLayout(templateId);
    expect(session.isDirty(tab)).toBe(false); expect(tab.doc.undoStack.canUndo).toBe(false);
    const saved = tab.doc.state, bytes = (await session.saveLayoutBytes(tab.id));
    const reopened = (await session.openLayoutBytes(bytes, 'Template.pfl'));
    expect(reopened.doc.state).toEqual(saved); expect(session.isDirty(reopened)).toBe(false);
  }
  const count = session.tabs.length, active = session.activeId;
  expect(() => session!.newLayout('unknown-template')).toThrow('Unknown');
  expect(session.tabs).toHaveLength(count); expect(session.activeId).toBe(active);
});

it('keeps template Frame content shared when adding, duplicating, and editing pages', async () => {
  session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
  const tab = session.newLayout('titleblock-a4');
  const frame = [...tab.doc.state.layers.values()].find(layer => layer.name === 'Frame')!;
  const count = tab.doc.state.sharedEntities.size;
  const id = tab.doc.state.sharedEntityOrder[0]!;
  const original = tab.doc.state.sharedEntities.get(id)!.points[0]!;
  const added = tab.commands.execute('layout.page.add', { name: 'Details' }) as number;
  tab.commands.execute('layout.page.duplicate', { pageId: added });
  expect(tab.doc.state.sharedEntities.size).toBe(count);
  for (const page of tab.doc.state.pages.values()) {
    expect(page.entities.size).toBe(0);
    expect(entitiesForLayer(page, tab.doc.state, frame.id)).toHaveLength(count);
  }
  tab.commands.execute('layout.shape.move', { pageId: added, entityIds: [id], delta: [5, 7] });
  for (const page of tab.doc.state.pages.values()) {
    expect(entitiesForLayer(page, tab.doc.state, frame.id)[0]!.points[0]).toEqual([original[0] + 5, original[1] + 7]);
  }
  const reopened = (await session.openLayoutBytes((await session.saveLayoutBytes(tab.id)), 'Frame.pfl'));
  expect(reopened.doc.state.layers.get(frame.id)).toMatchObject({ name: 'Frame', shared: true });
  expect(reopened.doc.state.sharedEntities).toEqual(tab.doc.state.sharedEntities);
  expect(reopened.doc.state.layers.get(reopened.doc.state.activeLayerId)?.name).toBe('Layer 1');
});
