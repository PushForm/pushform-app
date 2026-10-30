// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { DefId, Id } from '@pushform/core';
import { createDocument, allocId } from '@pushform/model';
import { writeNativeModel } from './modelWriter';
import { readNativeModel } from './modelReader';
import { NativeColumnBudget } from './columns';
import { nativeModelState } from './modelState';
async function encoded(doc = createDocument()) {
  const parts: Uint8Array[] = [];
  await writeNativeModel(doc.state, { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return { size: bytes.length, read: async (offset: number, length: number) => bytes.subarray(offset, offset + length) };
}
describe('packed model reader', () => {
  it('opens a new model without expanding empty geometry to legacy Maps', async () => {
    const doc = createDocument(), model = await readNativeModel(await encoded(doc));
    expect(model.settings.meta).toEqual(doc.state.meta); expect(model.catalogs.values.materials).toEqual(doc.state.materials);
    const root = model.definitions.get(doc.state.rootDefinitionId)!;
    expect(root.sketch?.vertices.ids).toBeInstanceOf(Uint32Array); expect(root.order).toBeInstanceOf(Uint32Array);
    expect(model.canonicalAndIndexBytes).toBe(16);
    expect(model.hasUnsupportedExtensions).toBe(false);
    model.hasUnsupportedExtensions = true;
    expect(() => nativeModelState(model)).toThrow('cannot preserve');
  });
  it('rejects invalid instance references and cycles before returning staged state', async () => {
    for (const missing of [false, true]) {
      const doc = createDocument();
      doc.transact('instance', d => {
        const id = allocId<Id>(d), e = d.definitions.get(d.rootDefinitionId)!.entities;
        e.instances.set(id, { id, definitionId: missing ? 999 as DefId : d.rootDefinitionId, name: '', materialId: null,
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], tagId: d.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} }); e.order.push(id);
      });
      await expect(readNativeModel(await encoded(doc))).rejects.toThrow(missing ? 'instance reference' : 'Cyclic');
    }
  });
  it('enforces the shared allocation budget and cancellation', async () => {
    const source = await encoded();
    await expect(readNativeModel(source, { budget: new NativeColumnBudget(15) })).rejects.toThrow('budget');
    const controller = new AbortController(); controller.abort();
    await expect(readNativeModel(source, { signal: controller.signal })).rejects.toThrow();
  });
  it('rejects cross-definition ID collisions before publishing a model', async () => {
    const doc = createDocument();
    doc.transact('duplicate vertex', d => {
      const root = d.definitions.get(d.rootDefinitionId)!, id = allocId<Id>(d), other = allocId<DefId>(d);
      root.entities.sketch.vertices.set(id, { id, p: [0, 0, 0] });
      d.definitions.set(other, { ...root, id: other, guid: crypto.randomUUID() as typeof root.guid });
    });
    await expect(readNativeModel(await encoded(doc))).rejects.toThrow('global persistent ID');
  });
  it('rejects collisions between catalog and geometry IDs', async () => {
    const doc = createDocument();
    doc.transact('catalog collision', d => {
      const id = d.defaultTagId as number as Id;
      d.definitions.get(d.rootDefinitionId)!.entities.sketch.vertices.set(id, { id, p: [0, 0, 0] });
    });
    await expect(readNativeModel(await encoded(doc))).rejects.toThrow('global persistent ID');
  });
  it('rejects an allocator that would reuse a stored ID, but accepts exhausted uint32 space', async () => {
    const doc = createDocument();
    doc.transact('stale allocator', d => { d.meta.nextId = d.activeStyleId; });
    await expect(readNativeModel(await encoded(doc))).rejects.toThrow('exceeds allocator');
    doc.transact('exhausted allocator', d => { d.meta.nextId = 0x100000000; });
    expect((await readNativeModel(await encoded(doc))).settings.meta.nextId).toBe(0x100000000);
  });
  it('charges and releases the temporary global ID validation buffer', async () => {
    const source = await encoded(), budget = new NativeColumnBudget(32);
    expect((await readNativeModel(source, { budget })).canonicalAndIndexBytes).toBe(16);
    expect(budget.usedBytes).toBe(16);
    await expect(readNativeModel(source, { budget: new NativeColumnBudget(31) })).rejects.toThrow('budget');
  });
});
