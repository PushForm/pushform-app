// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { m4identity, m4translation, type Id } from '@pushform/core';
import { containerAt, PLUGIN_DATA_LIMITS, type EntityRef, type PluginEntry, type PluginTarget } from '@pushform/model';
import { disposeKernels, setupCommands } from './transform.fixtures';
import { captureContainerOccurrence, isolateContainerOccurrence, groupCommands, type MakeResult } from './groups';
import { copyModelSelection, pasteModelClipboard } from './clipboard';
import { solidCommands } from './solids';
import { materialCommands } from './materials';

afterEach(disposeKernels);
const owner = 'io.example.parts';
const opaque = new Uint8Array([255, 0, 128]);
const bodyTarget = (id: number): PluginTarget => ({ kind: 'body', id });
const occurrence = (id: number, path: number[] = []): PluginTarget => ({ kind: 'bodyOccurrence', id, path });
const bodyRef = (id: number, path: number[] = []): EntityRef => ({ kind: 'body', id: id as Id, path: path as Id[] });
const instanceRef = (id: number): EntityRef => ({ kind: 'instance', id: id as Id, path: [] });
function setup() {
  const s = setupCommands();
  s.registry.registerAll(groupCommands);
  s.registry.registerAll(solidCommands);
  s.registry.registerAll(materialCommands);
  const entries = () => s.host.doc.state.pluginData!.get(owner)!.entries;
  const attach = (values: [string, PluginTarget, PluginEntry['references']?][]) => s.host.doc.transact('Attach opaque data', draft => {
    draft.pluginData = new Map([[owner, { dataVersion: 99, entries: new Map(values.map(([id, target, references = []]) => [id, { target, references, payload: opaque }])) }]]);
  });
  const group = (id: number) => s.registry.execute('group.make', { refs: [bodyRef(id)] }) as MakeResult;
  return { ...s, entries, attach, group };
}

it('copies bodies with fresh entry IDs, internal links and opaque newer payloads; explicit jobs keep their membership', async () => {
  const s = setup(), a = s.addBox(), b = s.addBox([2, 0, 0], [3, 1, 1]);
  s.attach([
    ['a', bodyTarget(a), [{ entryId: 'b', target: bodyTarget(b) }]], ['b', bodyTarget(b)],
    ['placement', occurrence(a)], ['job', { kind: 'document' }, [{ target: occurrence(a) }]],
  ]);
  const count = s.host.undoStack.length;
  const result = await s.apply({ refs: [bodyRef(a), bodyRef(b)], matrix: m4translation([0, 2, 0]), copy: true });
  const copiedA = [...s.entries()].find(([, entry]) => entry.target.kind === 'body' && entry.target.id === result.refs[0]!.id)!;
  const copiedB = [...s.entries()].find(([, entry]) => entry.target.kind === 'body' && entry.target.id === result.refs[1]!.id)!;
  expect(copiedA[0]).not.toBe('a');
  expect(copiedA[1].payload).toEqual(opaque);
  expect(copiedA[1].references).toEqual([{ entryId: copiedB[0], target: bodyTarget(result.refs[1]!.id) }]);
  expect(s.entries().get('job')!.references).toEqual([{ target: occurrence(a) }]);
  expect(s.entries().size).toBe(7);
  expect(s.host.undoStack.length).toBe(count + 1);
  s.host.undo(); expect(s.entries().size).toBe(4);
  s.host.redo(); expect(s.entries().get(copiedA[0])!.payload).toEqual(opaque);
});

it('regroups and explodes nested occurrences without changing their metadata identities', () => {
  const s = setup(), body = s.addBox();
  s.attach([['part', occurrence(body)], ['job', { kind: 'document' }, [{ entryId: 'part', target: occurrence(body) }]]]);
  const first = s.group(body), firstId = first.instanceId!;
  const second = s.registry.execute('group.make', { refs: [instanceRef(firstId)] }) as MakeResult;
  const expected = occurrence(body, [second.instanceId!, firstId]);
  expect(s.entries().get('part')!.target).toEqual(expected);
  expect(s.entries().get('job')!.references).toEqual([{ entryId: 'part', target: expected }]);
  s.registry.execute('group.explode', { refs: [instanceRef(second.instanceId!)] });
  expect(s.entries().get('part')!.target).toEqual(occurrence(body, [firstId]));
  s.registry.execute('group.explode', { refs: [instanceRef(firstId)] });
  expect(s.entries().get('part')!.target).toEqual(occurrence(body));
  s.host.undo(); expect(s.entries().get('part')!.target).toEqual(occurrence(body, [firstId]));
});

it('make-unique copies shared defaults and redirects placement references to their copied defaults', async () => {
  const s = setup(), body = s.addBox(), group = s.group(body), original = group.instanceId!;
  const copy = (await s.apply({ refs: [instanceRef(original)], matrix: m4translation([2, 0, 0]), copy: true })).refs[0]!.id;
  s.attach([
    ['shared', bodyTarget(body)], ['definition', { kind: 'definition', id: group.definitionId }],
    ['one', occurrence(body, [original]), [{ entryId: 'shared', target: bodyTarget(body) }]],
    ['two', occurrence(body, [copy]), [{ entryId: 'shared', target: bodyTarget(body) }]],
    ['job', { kind: 'document' }, [{ entryId: 'two', target: occurrence(body, [copy]) }]],
  ]);
  s.registry.execute('component.makeUnique', { refs: [instanceRef(copy)] });
  const copiedBody = [...containerAt(s.host.doc.state, [copy]).bodies.keys()][0]!;
  expect(copiedBody).not.toBe(body);
  const copiedDefault = [...s.entries()].find(([, entry]) => entry.target.kind === 'body' && entry.target.id === copiedBody)!;
  expect(s.entries().get('two')!.target).toEqual(occurrence(copiedBody, [copy]));
  expect(s.entries().get('two')!.references).toEqual([{ entryId: copiedDefault[0], target: bodyTarget(copiedBody) }]);
  expect(s.entries().get('one')!.references).toEqual([{ entryId: 'shared', target: bodyTarget(body) }]);
  expect(s.entries().get('job')!.references[0]).toEqual({ entryId: 'two', target: occurrence(copiedBody, [copy]) });
  s.host.undo(); expect(s.entries().get('two')!.target).toEqual(occurrence(body, [copy]));
  s.host.redo(); expect(s.entries().get('two')!.references[0]!.entryId).toBe(copiedDefault[0]);
});

it('explodes one shared placement with mapped overrides while retaining the other placement', async () => {
  const s = setup(), body = s.addBox(), group = s.group(body), first = group.instanceId!;
  const second = (await s.apply({ refs: [instanceRef(first)], matrix: m4translation([2, 0, 0]), copy: true })).refs[0]!.id;
  s.attach([['shared', bodyTarget(body)], ['one', occurrence(body, [first]), [{ entryId: 'shared', target: bodyTarget(body) }]], ['two', occurrence(body, [second])], ['group', { kind: 'group', id: first }]]);
  s.registry.execute('group.explode', { refs: [instanceRef(first)] });
  const newBody = [...s.root().bodies.keys()][0]!;
  expect(s.entries().get('one')!.target).toEqual(occurrence(newBody));
  expect(s.entries().get('two')!.target).toEqual(occurrence(body, [second]));
  const sharedCopy = [...s.entries()].find(([, entry]) => entry.target.kind === 'body' && entry.target.id === newBody)!;
  expect(s.entries().get('one')!.references).toEqual([{ entryId: sharedCopy[0], target: bodyTarget(newBody) }]);
  expect(s.entries().get('group')!.needsReview).toBe(true);
});

it('deletes owners and invalidates inbound links in one undo step without parsing payloads', () => {
  const s = setup(), body = s.addBox();
  s.attach([['part', bodyTarget(body)], ['occurrence', occurrence(body)], ['job', { kind: 'document' }, [{ entryId: 'part', target: bodyTarget(body) }, { target: occurrence(body) }]]]);
  const count = s.host.undoStack.length;
  s.registry.execute('model.deleteBody', { id: body });
  expect([...s.entries().keys()]).toEqual(['job']);
  expect(s.entries().get('job')!.references.every(ref => ref.unresolved)).toBe(true);
  expect(s.host.undoStack.length).toBe(count + 1);
  s.host.undo(); expect(s.entries().size).toBe(3); expect(s.entries().get('job')!.references.some(ref => ref.unresolved)).toBe(false);
  s.host.redo(); expect(s.entries().size).toBe(1);
});

it('retains ambiguous join and split attachments for review without assigning a manufacturing identity to every output', async () => {
  for (const mode of ['union', 'split']) {
    const s = setup(), a = s.addBox(), b = s.addBox([0.5, 0, 0], [1.5, 1, 1]);
    s.attach([['a', bodyTarget(a)], ['b', occurrence(b)], ['job', { kind: 'document' }, [{ entryId: 'a', target: bodyTarget(a) }]]]);
    await s.registry.execute(`solids.${mode}`, { a: bodyRef(a), b: bodyRef(b) });
    expect(s.entries().size).toBe(3);
    expect(s.entries().get('a')!.needsReview).toBe(true);
    expect(s.entries().get('b')!.needsReview).toBe(true);
    expect(s.entries().get('job')!.references[0]!.unresolved).toBe(true);
    expect(s.entries().get('b')!.payload).toEqual(opaque);
    s.host.undo(); expect(s.entries().get('a')!.needsReview).toBeUndefined();
    s.host.redo(); expect(s.entries().get('a')!.needsReview).toBe(true);
  }
});

it('pastes opaque metadata across documents and leaves unmapped references unresolved despite coincident IDs', () => {
  const a = setup(), copied = a.addBox(), external = a.addBox([2, 0, 0], [3, 1, 1]);
  a.attach([['copied', occurrence(copied), [{ target: bodyTarget(external) }]], ['outside', bodyTarget(external)], ['job', { kind: 'document' }]]);
  const clip = copyModelSelection(a.host.doc.state, [], [bodyRef(copied)])!;
  const b = setup(); b.addBox(); expect(b.addBox()).toBe(external);
  b.host.transact('Paste', () => b.host.edit('Paste', draft => pasteModelClipboard(draft, clip, [], m4identity())));
  const entries = [...b.entries().values()];
  expect(entries).toHaveLength(1);
  expect(entries[0]!.references).toEqual([{ target: bodyTarget(external), unresolved: true }]);
  expect(entries[0]!.payload).toEqual(opaque);
  expect(entries[0]!.target).not.toEqual(occurrence(copied));
  b.host.undo(); expect(b.host.doc.state.pluginData).toBeUndefined();
  b.host.redo(); expect([...b.entries().values()][0]!.references[0]!.unresolved).toBe(true);
});

it('keeps external same-document references shared and maps a nested copied occurrence into the destination context', () => {
  const s = setup(), body = s.addBox(), outside = s.addBox([2, 0, 0], [3, 1, 1]), group = s.group(body);
  s.attach([['part', occurrence(body, [group.instanceId!]), [{ target: bodyTarget(outside) }]]]);
  const path = [group.instanceId! as Id];
  const clip = copyModelSelection(s.host.doc.state, path, [bodyRef(body, path)])!;
  s.host.transact('Paste', () => s.host.edit('Paste', draft => pasteModelClipboard(draft, clip, [], m4identity())));
  const copy = [...s.entries()].find(([id]) => id !== 'part')![1];
  expect(copy.target.kind).toBe('bodyOccurrence');
  expect(copy.target).toEqual(occurrence([...s.root().bodies.keys()].find(id => id !== outside)!));
  expect(copy.references).toEqual([{ target: bodyTarget(outside) }]);
});

it('same-document paste reuses component defaults and copies only the new placement attachments', () => {
  const s = setup(), body = s.addBox(), group = s.group(body), inst = group.instanceId!;
  s.attach([['shared', bodyTarget(body)], ['part', occurrence(body, [inst]), [{ entryId: 'shared', target: bodyTarget(body) }]]]);
  const clip = copyModelSelection(s.host.doc.state, [], [instanceRef(inst)])!;
  let pasted: EntityRef[] = [];
  s.host.transact('Paste', () => s.host.edit('Paste', draft => { pasted = pasteModelClipboard(draft, clip, [], m4identity()); }));
  const newInst = pasted[0]!.id;
  expect(s.root().instances.get(newInst)!.definitionId).toBe(group.definitionId);
  expect(s.entries().size).toBe(3);
  const copy = [...s.entries()].find(([id]) => id !== 'shared' && id !== 'part')![1];
  expect(copy.target).toEqual(occurrence(body, [newInst]));
  expect(copy.references).toEqual([{ entryId: 'shared', target: bodyTarget(body) }]);
});

it('copies material metadata, deletes its owner with undo, and keeps pasted default-material properties off unrelated parts', () => {
  const s = setup(), material = s.registry.execute('material.create', { name: 'Maple', color: [1, 0.8, 0.5] }) as number;
  s.attach([['material', { kind: 'material', id: material }], ['job', { kind: 'document' }, [{ entryId: 'material', target: { kind: 'material', id: material } }]]]);
  const duplicate = s.registry.execute('material.duplicate', { id: material }) as number;
  expect([...s.entries().values()].some(entry => entry.target.kind === 'material' && entry.target.id === duplicate)).toBe(true);
  s.registry.execute('material.delete', { id: material });
  expect(s.entries().has('material')).toBe(false);
  expect(s.entries().get('job')!.references[0]!.unresolved).toBe(true);
  s.host.undo(); expect(s.entries().has('material')).toBe(true);
  const source = setup(), body = source.addBox();
  source.attach([['default', { kind: 'material', id: source.host.doc.state.defaultMaterialId }]]);
  const clip = copyModelSelection(source.host.doc.state, [], [bodyRef(body)])!;
  const target = setup(), existing = target.addBox();
  let pasted: EntityRef[] = [];
  target.host.transact('Paste', () => target.host.edit('Paste', draft => { pasted = pasteModelClipboard(draft, clip, [], m4identity()); }));
  const importedMaterial = target.body(pasted[0]!.id).materialId;
  expect(importedMaterial).not.toBeNull();
  expect(importedMaterial).not.toBe(target.host.doc.state.defaultMaterialId);
  expect(target.body(existing).materialId).toBeNull();
  expect([...target.entries().values()][0]!.target).toEqual({ kind: 'material', id: importedMaterial });
});

it('rejects incompatible pasted record versions and metadata quota overflow without a partial geometry edit', async () => {
  const source = setup(), id = source.addBox(); source.attach([['part', bodyTarget(id)]]);
  const clip = copyModelSelection(source.host.doc.state, [], [bodyRef(id)])!;
  const target = setup(); target.attach([['job', { kind: 'document' }]]);
  target.host.doc.transact('Older version', draft => { draft.pluginData!.get(owner)!.dataVersion = 1; });
  const before = target.host.doc.state;
  expect(() => target.host.transact('Paste', () => target.host.edit('Paste', draft => pasteModelClipboard(draft, clip, [], m4identity())))).toThrow(/different version/);
  expect(target.host.doc.state).toBe(before);
  source.host.doc.transact('Fill record', draft => {
    const record = draft.pluginData!.get(owner)!;
    for (let n = 0; n < 15; n++) record.entries.set(`large${n}`, { target: bodyTarget(id), references: [], payload: new Uint8Array(PLUGIN_DATA_LIMITS.entry - 1024) });
  });
  const full = source.host.doc.state, undo = source.host.undoStack.length;
  await expect(source.apply({ refs: [bodyRef(id)], matrix: m4translation([2, 0, 0]), copy: true })).rejects.toThrow(/large/);
  expect(source.host.doc.state).toBe(full); expect(source.host.undoStack.length).toBe(undo);
});


it('paints one deeply nested physical solid without changing siblings and retains opaque shared/placement links in one Undo', async () => {
  const s = setup(), body = s.addBox(), first = s.group(body).instanceId!;
  const second = (await s.apply({ refs: [instanceRef(first)], matrix: m4translation([2, 0, 0]), copy: true })).refs[0]!.id;
  const outer = (s.registry.execute('group.make', { refs: [instanceRef(first), instanceRef(second)] }) as MakeResult).instanceId!;
  const otherOuter = (await s.apply({ refs: [instanceRef(outer)], matrix: m4translation([0, 4, 0]), copy: true })).refs[0]!.id;
  s.attach([
    ['shared', bodyTarget(body)], ['one', occurrence(body, [outer, first]), [{ entryId: 'shared', target: bodyTarget(body) }]],
    ['sibling', occurrence(body, [outer, second])], ['other', occurrence(body, [otherOuter, first])],
    ['job', { kind: 'document' }, [{ entryId: 'one', target: occurrence(body, [outer, first]) }]],
  ]);
  const materialId = s.registry.execute('material.create', { name: 'Maple', color: [0.7, 0.6, 0.4] }) as number;
  const before = s.host.undoStack.length, bodyMesh = containerAt(s.host.doc.state, [outer as Id, first as Id]).bodies.get(body as Id)!.mesh;
  const painted = s.registry.execute('paint.part', { ref: { kind: 'body', id: body, path: [outer, first] }, materialId, scope: 'placement' }) as { ref: EntityRef; isolated: boolean };
  expect(painted.isolated).toBe(true); expect(painted.ref.id).not.toBe(body); expect(painted.ref.path[0]).toBe(outer);
  const selected = containerAt(s.host.doc.state, painted.ref.path).bodies.get(painted.ref.id)!;
  expect(selected.materialId).toBe(materialId); expect(selected.mesh.verts).toEqual(bodyMesh.verts);
  expect([...selected.faces.values()].every(face => face.frontMaterialId === materialId && face.backMaterialId === materialId)).toBe(true);
  expect(containerAt(s.host.doc.state, [otherOuter as Id, first as Id]).bodies.get(body as Id)!.materialId).toBeNull();
  const newOuter = containerAt(s.host.doc.state, [outer as Id]);
  const sibling = [...newOuter.instances.values()].find(instance => instance.id !== painted.ref.path[1])!;
  expect(containerAt(s.host.doc.state, [outer as Id, sibling.id]).bodies.get(body as Id)!.materialId).toBeNull();
  expect(s.entries().get('one')!.target).toEqual(occurrence(painted.ref.id, [...painted.ref.path]));
  const shared = [...s.entries()].find(([, entry]) => entry.target.kind === 'body' && entry.target.id === painted.ref.id)!;
  expect(s.entries().get('one')!.references).toEqual([{ entryId: shared[0], target: bodyTarget(painted.ref.id) }]);
  expect(s.entries().get('job')!.references).toEqual([{ entryId: 'one', target: occurrence(painted.ref.id, [...painted.ref.path]) }]);
  expect(s.entries().get('other')!.target).toEqual(occurrence(body, [otherOuter, first]));
  expect([...s.entries().values()].every(entry => !entry.needsReview && entry.payload.every((byte, index) => byte === opaque[index]))).toBe(true);
  expect(s.host.undoStack.length).toBe(before + 1); s.host.undo(); expect(s.entries().size).toBe(5);
  expect(containerAt(s.host.doc.state, [outer as Id, first as Id]).bodies.get(body as Id)!.materialId).toBeNull();
  s.host.redo(); expect(s.entries().get('one')!.target).toEqual(occurrence(painted.ref.id, [...painted.ref.path]));
});

it('shared part paint keeps identity and locked or context-remapping placement edits refuse before changing anything', async () => {
  const s = setup(), body = s.addBox(), first = s.group(body).instanceId!;
  const second = (await s.apply({ refs: [instanceRef(first)], matrix: m4translation([2, 0, 0]), copy: true })).refs[0]!.id;
  const ref = { kind: 'body', id: body, path: [first] };
  const materialId = s.registry.execute('material.create', { name: 'Birch', color: [0.8, 0.7, 0.5] }) as number;
  const result = s.registry.execute('paint.part', { ref, materialId, scope: 'shared' }) as { ref: EntityRef; isolated: boolean };
  expect(result.isolated).toBe(false); expect(result.ref.id).toBe(body);
  expect(containerAt(s.host.doc.state, [second]).bodies.get(body as Id)!.materialId).toBe(materialId);
  s.host.setContext([first as Id]); const state = s.host.doc.state;
  expect(() => s.registry.execute('paint.part', { ref, materialId: null, scope: 'placement' })).toThrow(/Leave this shared assembly/);
  expect(s.host.doc.state).toBe(state); s.host.setContext([]);
  s.registry.execute('instance.setLocked', { refs: [instanceRef(first)], locked: true }); const locked = s.host.doc.state;
  expect(() => s.registry.execute('paint.part', { ref, materialId: null, scope: 'shared' })).toThrow(/Unlock/);
  expect(s.host.doc.state).toBe(locked);
});


it('isolates a captured assembly with a composed identity map while keeping live context and other placements intact', async () => {
  const s = setup(), body = s.addBox(), inner = s.group(body).instanceId!;
  const sibling = (await s.apply({ refs: [instanceRef(inner)], matrix: m4translation([2, 0, 0]), copy: true })).refs[0]!.id;
  const outer = (s.registry.execute('group.make', { refs: [instanceRef(inner), instanceRef(sibling)] }) as MakeResult).instanceId!;
  const other = (await s.apply({ refs: [instanceRef(outer)], matrix: m4translation([0, 4, 0]), copy: true })).refs[0]!.id;
  s.attach([['shared', bodyTarget(body)], ['part', occurrence(body, [outer, inner]), [{entryId:'shared',target:bodyTarget(body)}]], ['other', occurrence(body, [other, inner])]]);
  const selection = s.host.selection.snapshot(), context = [...s.host.context.path], before = s.host.undoStack.length;
  captureContainerOccurrence(s.host,[outer,inner],true);
  const isolated = s.host.edit('Isolate captured assembly', draft => isolateContainerOccurrence(draft,[outer,inner]));
  const mappedBody = isolated.ids.get(body)! as Id;
  expect(isolated.isolated).toBe(true); expect(isolated.path[0]).toBe(outer); expect(isolated.path[1]).not.toBe(inner);
  expect(containerAt(s.host.doc.state,isolated.path).bodies.has(mappedBody)).toBe(true);
  expect(containerAt(s.host.doc.state,[other,inner] as Id[]).bodies.has(body as Id)).toBe(true);
  expect(s.entries().get('part')!.target).toEqual(occurrence(mappedBody,isolated.path));
  expect(s.entries().get('other')!.target).toEqual(occurrence(body,[other,inner]));
  expect(s.host.context.path).toEqual(context); expect(s.host.selection.snapshot()).toEqual(selection);
  expect(s.host.undoStack.length).toBe(before+1); s.host.undo();
  expect(containerAt(s.host.doc.state,[outer,inner] as Id[]).bodies.has(body as Id)).toBe(true); expect(s.entries().size).toBe(3);
});

it('captured assembly guards reject missing, locked, outside-context and context-remapping targets before mutation', async () => {
  const s=setup(),body=s.addBox(),inner=s.group(body).instanceId!;
  await s.apply({refs:[instanceRef(inner)],matrix:m4translation([2,0,0]),copy:true});
  const original=s.host.doc.state;
  expect(()=>captureContainerOccurrence(s.host,[999],true)).toThrow(/no longer exists/); expect(s.host.doc.state).toBe(original);
  s.host.setContext([inner as Id]); expect(()=>captureContainerOccurrence(s.host,[],true)).toThrow(/inside/);
  expect(()=>captureContainerOccurrence(s.host,[inner],true)).toThrow(/Leave this shared assembly/);
  expect(()=>captureContainerOccurrence(s.host,[inner],false)).not.toThrow(); s.host.setContext([]);
  s.registry.execute('instance.setLocked',{refs:[instanceRef(inner)],locked:true});const locked=s.host.doc.state;
  expect(()=>captureContainerOccurrence(s.host,[inner],false)).toThrow(/Unlock/);expect(s.host.doc.state).toBe(locked);
});
