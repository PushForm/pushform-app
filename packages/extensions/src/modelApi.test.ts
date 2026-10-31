// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandRegistry, DocumentHost, SERVICE_DOCUMENT, SERVICE_KERNEL, componentCommands, contextCommands, editCommands, groupCommands,
  materialCommands, modelCommands, sketchCommands, tagCommands, transformCommands,
} from '@pushform/commands';
import { MODEL_TOOLS, type ModelBatchResult } from '@pushform/extension-protocol';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { ModelApiFailure, ModelDocumentApi, runModelTool } from './modelApi';

const kernels: KernelClient[] = [];
afterEach(() => { for (const kernel of kernels.splice(0)) kernel.dispose(); });

function setup() {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const commands = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  for (const group of [editCommands, modelCommands, sketchCommands, transformCommands, groupCommands, componentCommands, contextCommands, tagCommands, materialCommands])
    commands.registerAll(group);
  const api = new ModelDocumentApi(commands, 'AI Chat');
  const root = () => host.doc.rootDefinition.entities;
  const addBox = (min: [number, number, number], max: [number, number, number]): number => commands.execute('model.addBox', { min, max }) as number;
  return { host, commands, api, root, addBox };
}
async function failure(run: () => Promise<unknown>): Promise<ModelApiFailure> {
  try { await run(); } catch (error) { if (error instanceof ModelApiFailure) return error; throw error; }
  throw new Error('expected a ModelApiFailure');
}
const box = (id: number) => ({ kind: 'body' as const, id });

describe('ModelDocumentApi reads', () => {
  it('reports the revision, units, edit context, definitions, tags and materials', async () => {
    const { api, addBox } = setup();
    addBox([0, 0, 0], [1, 2, 3]);
    await api.apply({ expectedRevision: api.revision, label: 'Seed', operations: [{ op: 'add_tag', name: 'Shelves', color: '#ff0000' }] });
    const snapshot = api.getDocument();
    expect(snapshot).toMatchObject({ apiVersion: 1, editContext: { path: [] }, selection: [], bounds: { min: [0, 0, 0], max: [1, 2, 3] }, definitions: [] });
    expect(snapshot.revision).toBe(api.revision);
    expect(snapshot.displayUnits.lengthUnit).toBeTruthy();
    expect(snapshot.tags.find(tag => tag.name === 'Shelves')).toMatchObject({ visible: true, color: '#ff0000', untagged: false });
    expect(snapshot.tags.some(tag => tag.untagged)).toBe(true);
    expect(snapshot.materials.some(material => material.isDefault)).toBe(true);
  });

  it('lists solids and, only when asked, their faces filtered by direction and point', () => {
    const { api, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 1, 1]);
    const listing = api.query({ container: null, kinds: null, ids: null, facing: null, containing: null, fields: null, offset: null, limit: null });
    expect(listing.total).toBe(1);
    expect(listing.entities[0]).toMatchObject({ ref: { path: [], kind: 'body', id }, faceCount: 6, bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
    expect(listing.entities[0]!.volume).toBeCloseTo(1);
    const top = api.query({ container: null, kinds: ['face'], ids: [id], facing: [0, 0, 1], containing: null, fields: ['geometry'], offset: null, limit: null });
    expect(top.total).toBe(1);
    expect(top.entities[0]).toMatchObject({ ref: { kind: 'face', id }, normal: [0, 0, 1], holes: 0 });
    expect(top.entities[0]!.area).toBeCloseTo(1);
    expect(top.entities[0]!.bounds).toBeUndefined();
    const side = api.query({ container: null, kinds: ['face'], ids: null, facing: null, containing: [1, 0.5, 0.5], fields: null, offset: null, limit: null });
    expect(side.entities.map(face => face.normal)).toEqual([[1, 0, 0]]);
  });

  it('pages and rejects malformed or unknown containers', () => {
    const { api, addBox } = setup();
    for (let i = 0; i < 3; i++) addBox([i * 2, 0, 0], [i * 2 + 1, 1, 1]);
    const page = api.query({ container: null, kinds: ['body'], ids: null, facing: null, containing: null, fields: null, offset: 1, limit: 1 });
    expect(page).toMatchObject({ total: 3, offset: 1, next: 2 });
    expect(() => api.query({ container: [999], kinds: null, ids: null, facing: null, containing: null, fields: null, offset: null, limit: null })).toThrow(/No group or component/);
    expect(() => api.query({ limit: 1000 })).toThrow(ModelApiFailure);
  });
});

describe('ModelDocumentApi batches', () => {
  it('groups, moves and arrays in one undo entry labelled with the client, with "$name" references', async () => {
    const { api, host, root, addBox } = setup();
    const a = addBox([0, 0, 0], [1, 1, 1]), b = addBox([2, 0, 0], [3, 1, 1]);
    const undoDepth = host.undoStack.length;
    const result = await api.apply({ expectedRevision: api.revision, label: 'Shelf row', operations: [
      { op: 'make_component', as: 'shelf', refs: [box(a), box(b)], name: 'Shelf' },
      { op: 'move', refs: ['$shelf'], offset: [0, 0, 1] },
      { op: 'move', refs: ['$shelf'], offset: [0, 2, 0], copies: 3 },
      { op: 'rename_instance', ref: '$shelf', name: 'First shelf' },
    ] }) as ModelBatchResult;
    expect(result).toMatchObject({ ok: true, label: 'AI Chat: Shelf row' });
    expect(result.revision).toBe(api.revision);
    const shelf = result.created.shelf!;
    expect(result.results[0]).toMatchObject({ op: 'make_component', id: shelf });
    expect(result.results[2]!.refs).toHaveLength(3);
    expect(host.undoStack.length).toBe(undoDepth + 1);
    expect(host.undoStack.peek()?.label).toBe('AI Chat: Shelf row');
    const instances = [...root().instances.values()];
    expect(instances).toHaveLength(4);
    expect(root().bodies.size).toBe(0);
    expect(root().instances.get(shelf as never)?.transform[14]).toBeCloseTo(1);
    expect(root().instances.get(shelf as never)?.name).toBe('First shelf');
    const definitions = api.getDocument().definitions;
    expect(definitions).toMatchObject([{ name: 'Shelf', type: 'component', placements: 4, solids: 2 }]);
    expect(host.undo()).toBe(true);
    expect(root().instances.size).toBe(0);
    expect(root().bodies.size).toBe(2);
  });

  it('rotates about an axis through a point, in degrees', async () => {
    const { api, root, addBox } = setup();
    addBox([1, 0, 0], [2, 1, 1]);
    const result = await api.apply({ expectedRevision: api.revision, label: 'Turn', operations: [
      { op: 'make_group', as: 'g', refs: [box([...root().bodies.keys()][0]!)] },
      { op: 'rotate', refs: ['$g'], origin: [0, 0, 0], axis: [0, 0, 1], angleDeg: 90 },
    ] });
    const bounds = api.query({ container: null, kinds: ['instance'], ids: [result.created.g!], facing: null, containing: null, fields: ['bounds'], offset: null, limit: null }).entities[0]!.bounds!;
    expect(bounds.min[0]).toBeCloseTo(-1);
    expect(bounds.max[0]).toBeCloseTo(0);
    expect(bounds.min[1]).toBeCloseTo(1);
    expect(bounds.max[1]).toBeCloseTo(2);
  });

  it('creates and assigns tags and paints with a new material', async () => {
    const { api, root, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 1, 1]);
    const top = api.query({ container: null, kinds: ['face'], ids: [id], facing: [0, 0, 1], containing: null, fields: null, offset: null, limit: null }).entities[0]!.ref;
    const result = await api.apply({ expectedRevision: api.revision, label: 'Finish', operations: [
      { op: 'add_tag', as: 'hidden', name: 'Hidden parts' },
      { op: 'add_material', as: 'oak', name: 'Oak', color: '#c8a165', opacity: 0.5 },
      { op: 'paint', refs: [{ kind: 'face', id, faceId: top.faceId! }], materialId: '$oak' },
      { op: 'assign_tag', refs: [box(id)], tagId: '$hidden' },
      { op: 'set_tag', tagId: '$hidden', visible: false, color: '#000000' },
    ] });
    const body = root().bodies.get(id as never)!;
    expect(body.tagId).toBe(result.created.hidden);
    expect(body.faces.get(top.faceId as never)?.frontMaterialId).toBe(result.created.oak);
    const doc = api.getDocument();
    expect(doc.tags.find(tag => tag.id === result.created.hidden)).toMatchObject({ visible: false, color: '#000000' });
    expect(doc.materials.find(m => m.id === result.created.oak)).toMatchObject({ name: 'Oak', color: '#c8a165', opacity: 0.5 });
  });

  it('places, explodes, makes unique, hides, locks and deletes', async () => {
    const { api, root, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 1, 1]);
    const made = await api.apply({ expectedRevision: api.revision, label: 'Legs', operations: [
      { op: 'make_component', as: 'leg', refs: [box(id)], name: 'Leg' },
      { op: 'place_component', as: 'leg2', definitionId: '$leg', position: [5, 0, 0] },
      { op: 'make_unique', refs: ['$leg2'] },
      { op: 'rename_definition', definitionId: '$leg2', name: 'Long leg' },
      { op: 'set_locked', refs: ['$leg'], locked: true },
      { op: 'set_hidden', refs: ['$leg2'], hidden: true },
    ] });
    const leg2 = root().instances.get(made.created.leg2 as never)!;
    expect(leg2.hidden).toBe(true);
    expect(leg2.transform[12]).toBeCloseTo(5);
    expect(root().instances.get(made.created.leg as never)?.locked).toBe(true);
    expect(api.getDocument().definitions.map(def => def.name).sort()).toEqual(['Leg', 'Long leg']);
    await api.apply({ expectedRevision: api.revision, label: 'Tidy', operations: [
      { op: 'explode', refs: [{ kind: 'instance', id: made.created.leg2! }] },
      { op: 'set_locked', refs: [{ kind: 'instance', id: made.created.leg! }], locked: false },
      { op: 'delete', refs: [{ kind: 'instance', id: made.created.leg! }] },
    ] });
    expect(root().instances.size).toBe(0);
    expect(root().bodies.size).toBe(1);
  });

  it('edits inside a group named by its instance path and leaves the editor where it was', async () => {
    const { api, host, root, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 1, 1]);
    const grouped = await api.apply({ expectedRevision: api.revision, label: 'Group', operations: [{ op: 'make_group', as: 'g', refs: [box(id)] }] });
    const path = [grouped.created.g!];
    const inside = api.query({ container: path, kinds: ['body'], ids: null, facing: null, containing: null, fields: null, offset: null, limit: null });
    expect(inside.entities).toHaveLength(1);
    await api.apply({ expectedRevision: api.revision, container: path, label: 'Raise', operations: [{ op: 'move', refs: [{ kind: 'body', id: inside.entities[0]!.ref.id }], offset: [0, 0, 2] }] });
    expect(host.context.path).toEqual([]);
    const def = host.doc.state.definitions.get(root().instances.get(path[0] as never)!.definitionId)!;
    const moved = [...def.entities.bodies.values()][0]!;
    expect(Math.min(...Array.from(moved.mesh.verts).filter((_, i) => i % 3 === 2))).toBeCloseTo(2);
  });

  it('changes nothing when an operation fails, and names the failing operation', async () => {
    const { api, host, root, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 1, 1]);
    const revision = api.revision, undoDepth = host.undoStack.length;
    const error = await failure(() => api.apply({ expectedRevision: revision, label: 'Broken', operations: [
      { op: 'make_group', as: 'g', refs: [box(id)] },
      { op: 'move', refs: ['$g'], offset: [1, 0, 0] },
      { op: 'move', refs: [{ kind: 'body', id: 9999 }], offset: [1, 0, 0] },
    ] }));
    expect(error.error).toMatchObject({ code: 'invalid_reference', operationIndex: 2 });
    expect(root().instances.size).toBe(0);
    expect(root().bodies.size).toBe(1);
    expect(host.undoStack.length).toBe(undoDepth);
    expect(host.undoStack.grouped).toBe(false);
    expect(error.error.revision).toBe(api.revision);
  });

  it('refuses stale revisions, unknown names, unavailable and malformed operations before changing anything', async () => {
    const { api, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 1, 1]);
    const revision = api.revision;
    expect((await failure(() => api.apply({ expectedRevision: revision - 1, label: 'x', operations: [{ op: 'add_tag' }] }))).error.code).toBe('stale_revision');
    expect((await failure(() => api.apply({ expectedRevision: revision, label: 'x', operations: [{ op: 'move', refs: ['$nope'], offset: [1, 0, 0] }] }))).error.code).toBe('invalid_reference');
    const unavailable = await failure(() => api.apply({ expectedRevision: revision, label: 'x', operations: [{ op: 'add_tag' }, { op: 'push_pull', distance: 1 }] }));
    expect(unavailable.error).toMatchObject({ code: 'unavailable', operationIndex: 1 });
    expect((await failure(() => api.apply({ expectedRevision: revision, label: 'x', operations: [{ op: 'teleport' }] }))).error.code).toBe('invalid_operation');
    expect((await failure(() => api.apply({ expectedRevision: revision, label: 'x', operations: Array.from({ length: 201 }, () => ({ op: 'add_tag' })) }))).error.code).toBe('limit_exceeded');
    expect((await failure(() => api.apply({ expectedRevision: revision, label: 'x', operations: [{ op: 'delete', refs: [{ kind: 'face', id, faceId: 0 }] }] }))).error.code).toMatch(/invalid_geometry|invalid_reference/);
    expect(api.revision).toBe(revision);
  });

  it('refuses other edits while a batch waits on the kernel, and a stopped batch changes nothing', async () => {
    const { api, commands, root, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 1, 1]);
    const pending = api.apply({ expectedRevision: api.revision, label: 'Stretch', operations: [{ op: 'scale', refs: [box(id)], origin: [0, 0, 0], factors: [2, 1, 1] }] });
    expect(() => commands.execute('model.addBox', { min: [5, 5, 5], max: [6, 6, 6] })).toThrow(/being applied/);
    await pending;
    expect(root().bodies.size).toBe(1);
    expect(root().bodies.get(id as never)!.props.volume).toBeCloseTo(2);
    const controller = new AbortController();
    const stopped = api.apply({ expectedRevision: api.revision, label: 'Stop', operations: [
      { op: 'scale', refs: [box(id)], origin: [0, 0, 0], factors: [2, 1, 1] },
      { op: 'add_tag', name: 'Never' },
    ] }, controller.signal);
    controller.abort();
    expect((await failure(() => stopped)).error.code).toBe('cancelled');
    expect(root().bodies.get(id as never)!.props.volume).toBeCloseTo(2);
    expect(api.getDocument().tags.some(tag => tag.name === 'Never')).toBe(false);
  });
});

describe('runModelTool', () => {
  it('returns results and errors as tool results', async () => {
    const { api } = setup();
    expect((await runModelTool(api, MODEL_TOOLS.getDocument.name, {})).isError).toBe(false);
    const stale = await runModelTool(api, MODEL_TOOLS.applyOperations.name, { expectedRevision: 99, label: 'x', operations: [{ op: 'add_tag' }] });
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.content).error.code).toBe('stale_revision');
    expect(JSON.parse((await runModelTool(api, 'model_teleport', {})).content).error.code).toBe('invalid_operation');
  });
});
