// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandRegistry, DocumentHost, SERVICE_DOCUMENT, SERVICE_FONTS, SERVICE_KERNEL, componentCommands, contextCommands, curveCommands, dimensionCommands,
  edgeBlendCommands, edgeCommands, editCommands, followMeCommands, groupCommands, guideCommands, intersectCommands, materialCommands, modelCommands,
  offsetCommands, pushPullCommands, sectionPlaneCommands, sketchCommands, solidCommands, tagCommands, text3dCommands, textCommands, transformCommands,
  type FontSource,
} from '@pushform/commands';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { MODEL_TOOLS, type ModelBatchResult } from '@pushform/extension-protocol';
import { basisToLocal } from '@pushform/core';
import { uvAt } from '@pushform/model';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { ModelApiFailure, ModelDocumentApi, runModelTool } from './modelApi';

const kernels: KernelClient[] = [];
afterEach(() => { for (const kernel of kernels.splice(0)) kernel.dispose(); });

/** Roboto for every family, from the commands package's test fonts. */
const fontFile = (name: string): ArrayBuffer => {
  const b = readFileSync(createRequire(new URL('../../commands/package.json', import.meta.url)).resolve(`@fontsource/roboto/files/${name}`));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const fonts: FontSource = { load: (_font, bold) => Promise.resolve([fontFile(`roboto-latin-${bold ? 700 : 400}-normal.woff`)]) };

function setup(options: { fonts?: boolean } = {}) {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const services = new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]);
  if (options.fonts) services.set(SERVICE_FONTS, fonts);
  const commands = new CommandRegistry({ tx: host, services });
  for (const group of [editCommands, modelCommands, sketchCommands, transformCommands, groupCommands, componentCommands, contextCommands, tagCommands, materialCommands,
    curveCommands, pushPullCommands, solidCommands, followMeCommands, edgeBlendCommands, offsetCommands, intersectCommands, edgeCommands, guideCommands,
    dimensionCommands, textCommands, text3dCommands, sectionPlaneCommands])
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

  it('builds a cabinet carcass from boxes as one undo step, each panel its own component', async () => {
    const { api, host, root } = setup();
    const t = 0.019, w = 0.9144, h = 1.2192, d = 0.3048;
    const result = await api.apply({ expectedRevision: api.revision, label: 'Wall cabinet', operations: [
      { op: 'add_box', as: 'left', min: [0, 0, 0], max: [t, d, h] },
      { op: 'add_box', as: 'right', min: [w - t, 0, 0], max: [w, d, h] },
      { op: 'add_box', as: 'shelf', min: [t, 0, h / 3], max: [w - t, d, h / 3 + t] },
      { op: 'make_component', as: 'shelfPart', refs: ['$shelf'], name: 'Shelf' },
      { op: 'move', refs: ['$shelfPart'], offset: [0, 0, h / 3], copy: true },
      { op: 'make_group', refs: ['$left'] },
      { op: 'make_group', refs: ['$right'] },
    ] });
    expect(result.results.slice(0, 3).map(r => r.op)).toEqual(['add_box', 'add_box', 'add_box']);
    expect(root().bodies.size).toBe(0);
    expect(root().instances.size).toBe(4);
    const shelves = api.query({ container: null, kinds: ['instance'], ids: null, facing: null, containing: null, fields: null, offset: null, limit: null })
      .entities.filter(e => e.definitionId === result.results[3]!.definitionId);
    expect(shelves).toHaveLength(2);
    expect(host.undoStack.canUndo).toBe(true);
    host.undoStack.undo();
    expect(root().instances.size + root().bodies.size).toBe(0);
  });

  it('refuses a box that is flat or inverted on any axis without changing anything', async () => {
    const { api } = setup();
    const revision = api.revision;
    const flat = await failure(() => api.apply({ expectedRevision: revision, label: 'x', operations: [{ op: 'add_box', min: [0, 0, 0], max: [1, 0, 1] }] }));
    expect(flat.error).toMatchObject({ code: 'invalid_geometry', operationIndex: 0 });
    expect(flat.error.message).toContain('y');
    expect(api.revision).toBe(revision);
  });

  it('refuses stale revisions, unknown names, unavailable and malformed operations before changing anything', async () => {
    const { api, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 1, 1]);
    const revision = api.revision;
    expect((await failure(() => api.apply({ expectedRevision: revision - 1, label: 'x', operations: [{ op: 'add_tag' }] }))).error.code).toBe('stale_revision');
    expect((await failure(() => api.apply({ expectedRevision: revision, label: 'x', operations: [{ op: 'move', refs: ['$nope'], offset: [1, 0, 0] }] }))).error.code).toBe('invalid_reference');
    const unavailable = await failure(() => api.apply({ expectedRevision: revision, label: 'x', operations: [{ op: 'add_tag' }, { op: 'set_attribute', key: 'x' }] }));
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

describe('ModelDocumentApi geometry', () => {
  const queryAll = { container: null, kinds: null, ids: null, facing: null, containing: null, fields: null, offset: null, limit: null };
  const bounds = (api: ModelDocumentApi, id: number) => api.query({ ...queryAll, kinds: ['body'], ids: [id] }).entities[0]!.bounds!;

  it('pulls a drawn rectangle into a solid, then cuts a groove in it with a box, as one undo step', async () => {
    const { api, host, root } = setup();
    const undoDepth = host.undoStack.length;
    // A 0.6 m × 0.05 m door rail lying flat, 0.02 m thick, with a 0.006 m × 0.01 m groove along its top edge.
    const result = await api.apply({ expectedRevision: api.revision, label: 'Grooved rail', operations: [
      { op: 'add_rectangle', as: 'outline', corner: [0, 0, 0], side1: [0.6, 0, 0], side2: [0, 0.05, 0] },
      { op: 'push_pull', as: 'rail', face: '$outline', distance: 0.02 },
      { op: 'add_box', as: 'cutter', min: [-0.01, 0.04, 0.007], max: [0.61, 0.06, 0.013] },
      { op: 'subtract', target: '$rail', cutters: ['$cutter'] },
      { op: 'make_group', refs: ['$rail'] },
    ] });
    expect(result.results[0]).toMatchObject({ op: 'add_rectangle' });
    expect(result.results[0]!.refs!.filter(r => r.kind === 'sketchEdge')).toHaveLength(4);
    expect(result.results[0]!.refs!.filter(r => r.kind === 'sketchFace')).toHaveLength(1);
    const rail = result.created.rail!;
    expect(result.results[1]).toMatchObject({ op: 'push_pull', id: rail });
    expect(result.results[3]).toMatchObject({ op: 'subtract', id: rail, deleted: [{ kind: 'body', id: result.created.cutter }] });
    expect(host.undoStack.length).toBe(undoDepth + 1);
    expect(root().sketch.faces.size + root().sketch.edges.size).toBe(0);
    const def = host.doc.state.definitions.get([...root().instances.values()][0]!.definitionId)!;
    const body = def.entities.bodies.get(rail as never)!;
    expect(body.valid).toBe(true);
    expect(body.props.volume).toBeCloseTo(0.6 * 0.05 * 0.02 - 0.6 * 0.01 * 0.006, 9);
    host.undo();
    expect(root().instances.size + root().bodies.size + root().sketch.edges.size).toBe(0);
  });

  it('pushes a shape the way it faces: side1 × side2, or the right-hand rule of a closed polyline', async () => {
    const { api } = setup();
    const result = await api.apply({ expectedRevision: api.revision, label: 'Profiles', operations: [
      { op: 'add_rectangle', as: 'down', corner: [0, 0, 0], side1: [0, 1, 0], side2: [1, 0, 0] },
      { op: 'push_pull', as: 'slab', face: '$down', distance: 0.1 },
      // An L-shaped profile in the side (x = 2) plane, wound counterclockwise seen from +x, pushed out 0.5 m along +x.
      { op: 'add_polyline', as: 'ell', closed: true, points: [[2, 0, 0], [2, 0.3, 0], [2, 0.3, 0.1], [2, 0.1, 0.1], [2, 0.1, 0.4], [2, 0, 0.4]] },
      { op: 'push_pull', as: 'bracket', face: '$ell', distance: 0.5 },
    ] });
    expect(bounds(api, result.created.slab!)).toMatchObject({ min: [0, 0, -0.1], max: [1, 1, 0] });
    expect(bounds(api, result.created.bracket!)).toMatchObject({ min: [2, 0, 0], max: [2.5, 0.3, 0.4] });
    const { root } = { root: () => api.query({ ...queryAll, kinds: ['body'], ids: [result.created.bracket!] }).entities[0]! };
    expect(root().volume).toBeCloseTo((0.3 * 0.1 + 0.1 * 0.3) * 0.5, 9);
  });

  it('bores a hole through a solid with a circle drawn on its face, and raises a polygon from the ground', async () => {
    const { api, root, addBox } = setup();
    const top = addBox([0, 0, 0], [1, 1, 0.1]);
    const result = await api.apply({ expectedRevision: api.revision, label: 'Sink cutout', operations: [
      { op: 'add_circle', as: 'hole', center: [0.5, 0.5, 0.1], normal: [0, 0, 1], radius: 0.2, segments: 32 },
      { op: 'push_pull', face: '$hole', distance: -0.1 },
      { op: 'add_polygon', as: 'hex', center: [3, 0, 0], normal: [0, 0, 1], radius: 0.1, sides: 6 },
      { op: 'push_pull', as: 'post', face: '$hex', distance: 0.2 },
    ] });
    expect(result.results[0]!.refs).toContainEqual({ path: [], kind: 'face', id: top, faceId: expect.any(Number) });
    expect(result.results[1]).toMatchObject({ id: top });
    const ring = 0.5 * 32 * 0.2 ** 2 * Math.sin((2 * Math.PI) / 32);
    expect(root().bodies.get(top as never)!.props.volume).toBeCloseTo(0.1 - ring * 0.1, 6);
    const post = root().bodies.get(result.created.post as never)!;
    expect(post.props.volume).toBeCloseTo(0.5 * 6 * 0.01 * Math.sin(Math.PI / 3) * 0.2, 7);
    expect(bounds(api, post.id).max[0]).toBeCloseTo(3.1);
  });

  it('pulls a face of a solid chosen by facing direction, and refuses a push that would remove the solid', async () => {
    const { api, host, root, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 1, 1]);
    await api.apply({ expectedRevision: api.revision, label: 'Taller', operations: [{ op: 'push_pull', face: { body: id, facing: [0, 0, 1] }, distance: 0.5 }] });
    expect(root().bodies.get(id as never)!.props.volume).toBeCloseTo(1.5);
    const revision = api.revision, undoDepth = host.undoStack.length;
    const error = await failure(() => api.apply({ expectedRevision: revision, label: 'Gone', operations: [
      { op: 'add_tag', name: 'Before' },
      { op: 'push_pull', face: { body: id, facing: [0, 0, 1] }, distance: -1.5 },
    ] }));
    expect(error.error).toMatchObject({ code: 'invalid_geometry', operationIndex: 1 });
    expect(root().bodies.get(id as never)!.props.volume).toBeCloseTo(1.5);
    expect(api.getDocument().tags.some(tag => tag.name === 'Before')).toBe(false);
    expect(host.undoStack.length).toBe(undoDepth);
    const none = await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [{ op: 'push_pull', face: { body: id, facing: [1, 1, 0] }, distance: 0.1 }] }));
    expect(none.error.code).toBe('invalid_reference');
    const named = await api.apply({ expectedRevision: api.revision, label: 'Leg', operations: [
      { op: 'add_box', as: 'leg', min: [3, 0, 0], max: [3.1, 0.1, 0.1] },
      { op: 'push_pull', face: { body: '$leg', facing: [0, 0, 1] }, distance: 0.6 },
    ] });
    expect(bounds(api, named.created.leg!).max[2]).toBeCloseTo(0.7);
  });

  it('asks for a point when shapes drawn on a face divide it', async () => {
    const { api, root, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 1, 0.2]);
    await api.apply({ expectedRevision: api.revision, label: 'Mark', operations: [{ op: 'add_rectangle', corner: [0.2, 0.2, 0.2], side1: [0.2, 0, 0], side2: [0, 0.2, 0] }] });
    const divided = await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [{ op: 'push_pull', face: { body: id, facing: [0, 0, 1] }, distance: -0.1 }] }));
    expect(divided.error.code).toBe('invalid_reference');
    expect(divided.error.message).toContain('point');
    await api.apply({ expectedRevision: api.revision, label: 'Pocket', operations: [{ op: 'push_pull', face: { body: id, facing: [0, 0, 1], point: [0.3, 0.3, 0.2] }, distance: -0.1 }] });
    expect(root().bodies.get(id as never)!.props.volume).toBeCloseTo(0.2 - 0.04 * 0.1);
  });

  it('refuses a closed shape that lies partly along a face of a solid and so makes no face', async () => {
    const { api, addBox } = setup();
    addBox([0, 0, 0], [1, 1, 1]);
    const error = await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [
      { op: 'add_rectangle', corner: [0, 0, 1], side1: [3, 0, 0], side2: [0, 1, 0] }] }));
    expect(error.error).toMatchObject({ code: 'invalid_geometry', operationIndex: 0 });
    expect(error.error.message).toContain('clear of solids');
  });

  it('draws loose edges and open polylines, closing a flat loop into a face', async () => {
    const { api } = setup();
    const result = await api.apply({ expectedRevision: api.revision, label: 'Lines', operations: [
      { op: 'add_edges', as: 'tri', edges: [[[0, 0, 0], [1, 0, 0]], [[1, 0, 0], [0, 1, 0]], [[0, 1, 0], [0, 0, 0]]] },
      { op: 'add_polyline', as: 'path', points: [[5, 0, 0], [6, 0, 0], [6, 1, 1]] },
    ] });
    expect(result.results[0]!.refs!.map(r => r.kind).sort()).toEqual(['sketchEdge', 'sketchEdge', 'sketchEdge', 'sketchFace']);
    expect(result.results[1]!.refs!.map(r => r.kind)).toEqual(['sketchEdge', 'sketchEdge']);
    const open = await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [
      { op: 'add_polyline', as: 'p', points: [[5, 5, 0], [6, 5, 0]] }, { op: 'push_pull', face: '$p', distance: 1 }] }));
    expect(open.error).toMatchObject({ code: 'invalid_reference', operationIndex: 1 });
  });

  it('refuses shapes that cannot make a face, before changing anything', async () => {
    const { api } = setup();
    const revision = api.revision;
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ op: 'add_rectangle', corner: [0, 0, 0], side1: [1, 0, 0], side2: [0.5, 1, 0] }, /square/],
      [{ op: 'add_rectangle', corner: [0, 0, 0], side1: [1, 0, 0], side2: [0, 0, 0] }, /longer/],
      [{ op: 'add_polyline', closed: true, points: [[0, 0, 0], [1, 0, 0], [1, 1, 0.5], [0, 1, 0]] }, /flat/],
      [{ op: 'add_polyline', closed: true, points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }, /line/],
      [{ op: 'add_edges', edges: [[[0, 0, 0], [0, 0, 0]]] }, /no length/],
      [{ op: 'add_circle', center: [0, 0, 0], normal: [0, 0, 1], radius: 1e-5 }, /too small/],
      [{ op: 'push_pull', face: { kind: 'sketchFace', id: 1 }, distance: 0 }, /distance/],
    ];
    for (const [op, message] of cases) {
      const error = await failure(() => api.apply({ expectedRevision: revision, label: 'x', operations: [op] }));
      expect(error.error.code).toBe('invalid_geometry');
      expect(error.error.message).toMatch(message);
    }
    expect(api.revision).toBe(revision);
    const tooMany = await failure(() => api.apply({ expectedRevision: revision, label: 'x', operations: [
      { op: 'add_polyline', points: Array.from({ length: 6000 }, (_, i) => [i, 0, 0]) },
      { op: 'add_polyline', points: Array.from({ length: 6000 }, (_, i) => [i, 1, 0]) },
    ] }));
    expect(tooMany.error.code).toBe('limit_exceeded');
  });

  it('joins, intersects and splits solids, and refuses ones that do not touch or overlap', async () => {
    const { api, root, addBox } = setup();
    const a = addBox([0, 0, 0], [1, 1, 1]), b = addBox([0.5, 0, 0], [1.5, 1, 1]);
    const joined = await api.apply({ expectedRevision: api.revision, label: 'Join', operations: [{ op: 'union', as: 'both', refs: [box(a), box(b)] }] });
    expect(joined.results[0]).toMatchObject({ id: a, deleted: [{ kind: 'body', id: b }] });
    expect(root().bodies.size).toBe(1);
    expect(root().bodies.get(a as never)!.props.volume).toBeCloseTo(1.5);
    const far = addBox([5, 5, 5], [6, 6, 6]);
    expect((await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [{ op: 'union', refs: [box(a), box(far)] }] }))).error.code).toBe('invalid_geometry');
    expect((await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [{ op: 'intersect', refs: [box(a), box(far)] }] }))).error.code).toBe('invalid_geometry');
    expect((await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [{ op: 'split', refs: [box(a), box(far)] }] }))).error.code).toBe('invalid_geometry');
    expect((await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [{ op: 'subtract', target: box(a), cutters: [box(far)] }] }))).error.message).toMatch(/does not overlap/);
    expect(root().bodies.size).toBe(2);
    const c = addBox([1, 0, 0], [2, 1, 1]);
    const split = await api.apply({ expectedRevision: api.revision, label: 'Split', operations: [{ op: 'split', refs: [box(a), box(c)] }] });
    expect(split.results[0]!.refs).toHaveLength(3);
    const volumes = split.results[0]!.refs!.map(r => root().bodies.get(r.id as never)!.props.volume).sort();
    expect(volumes[0]).toBeCloseTo(0.5);
    expect(volumes[1]).toBeCloseTo(0.5);
    expect(volumes[2]).toBeCloseTo(1);
    const d = addBox([10, 0, 0], [11, 1, 1]), e = addBox([10.5, 0.5, 0], [11.5, 1.5, 1]);
    const shared = await api.apply({ expectedRevision: api.revision, label: 'Common', operations: [{ op: 'intersect', refs: [box(d), box(e)] }] });
    expect(shared.results[0]).toMatchObject({ id: d });
    expect(root().bodies.get(d as never)!.props.volume).toBeCloseTo(0.25);
    expect(root().bodies.has(e as never)).toBe(false);
  });

  it('subtracts several cutters and can keep them; refuses a cut that leaves nothing or targets a group', async () => {
    const { api, root, addBox } = setup();
    const panel = addBox([0, 0, 0], [1, 0.02, 1]);
    const result = await api.apply({ expectedRevision: api.revision, label: 'Dadoes', operations: [
      { op: 'add_box', as: 'd1', min: [-0.1, 0.01, 0.3], max: [1.1, 0.03, 0.32] },
      { op: 'add_box', as: 'd2', min: [-0.1, 0.01, 0.6], max: [1.1, 0.03, 0.62] },
      { op: 'subtract', target: box(panel), cutters: ['$d1', '$d2'], keepCutters: true },
    ] });
    expect(root().bodies.get(panel as never)!.props.volume).toBeCloseTo(0.02 - 2 * 0.01 * 0.02, 9);
    expect(root().bodies.has(result.created.d1 as never)).toBe(true);
    const all = await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [
      { op: 'add_box', as: 'big', min: [-1, -1, -1], max: [2, 2, 2] }, { op: 'subtract', target: box(panel), cutters: ['$big'] }] }));
    expect(all.error).toMatchObject({ code: 'invalid_geometry', operationIndex: 1 });
    const grouped = await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [
      { op: 'make_group', as: 'g', refs: [box(panel)] }, { op: 'subtract', target: '$g', cutters: [box(result.created.d1!)] }] }));
    expect(grouped.error.code).toBe('invalid_operation');
    expect(root().bodies.size).toBe(3);
  });

  it('sweeps a profile along path points or a drawn polyline with Follow Me', async () => {
    const { api, root } = setup();
    const result = await api.apply({ expectedRevision: api.revision, label: 'Mouldings', operations: [
      { op: 'add_rectangle', as: 'profile', corner: [0, 0, 0], side1: [0, 0.1, 0], side2: [0, 0, 0.05] },
      { op: 'follow_me', as: 'rail', profile: '$profile', pathPoints: [[0, 0, 0], [1, 0, 0]] },
      { op: 'add_rectangle', as: 'profile2', corner: [0, 5, 0], side1: [0, 0.1, 0], side2: [0, 0, 0.05] },
      { op: 'add_polyline', as: 'path', points: [[0, 5, 0], [2, 5, 0]] },
      { op: 'follow_me', as: 'rail2', profile: '$profile2', pathEdges: ['$path'] },
    ] });
    expect(root().bodies.get(result.created.rail as never)!.props.volume).toBeCloseTo(0.005, 9);
    expect(root().bodies.get(result.created.rail2 as never)!.props.volume).toBeCloseTo(0.01, 9);
    const both = await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [
      { op: 'follow_me', profile: { kind: 'sketchFace', id: 1 }, pathPoints: [[0, 0, 0], [1, 0, 0]], pathEdges: [{ kind: 'sketchEdge', id: 1 }] }] }));
    expect(both.error.code).toBe('invalid_operation');
  });
});

describe('ModelDocumentApi phase 2: edges, more shapes, annotation, materials and overlaps', () => {
  const queryAll = { container: null, kinds: null, ids: null, facing: null, containing: null, fields: null, offset: null, limit: null };
  const volumeOf = (api: ModelDocumentApi, id: number) => api.query({ ...queryAll, kinds: ['body'], ids: [id] }).entities[0]!.volume!;

  it('lists the edges of a solid by direction and point, with keys, length and faces', () => {
    const { api, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 2, 3]);
    const all = api.query({ ...queryAll, kinds: ['edge'], ids: [id] });
    expect(all.total).toBe(12);
    const vertical = api.query({ ...queryAll, kinds: ['edge'], ids: [id], facing: [0, 0, -1] });
    expect(vertical.total).toBe(4);
    expect(vertical.entities[0]).toMatchObject({ ref: { kind: 'edge', id, edgeKey: expect.any(String) }, length: 3, faces: [expect.any(Number), expect.any(Number)] });
    expect(api.query({ ...queryAll, kinds: ['edge'], ids: [id], containing: [0, 0, 0] }).total).toBe(3);
  });

  it('rounds over the top edges of a slab and bevels its corners, and refuses stale keys and oversized radii', async () => {
    const { api, host, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 1, 0.1]);
    await api.apply({ expectedRevision: api.revision, label: 'Round over', operations: [{ op: 'fillet_edges', body: box(id), edges: [{ faceFacing: [0, 0, 1] }], radius: 0.02, segments: 24 }] });
    const lost = 0.02 ** 2 * (1 - Math.PI / 4);
    expect(volumeOf(api, id)).toBeLessThan(0.1 - 3 * lost);
    expect(volumeOf(api, id)).toBeGreaterThan(0.1 - 5 * lost);
    const corner = await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [{ op: 'chamfer_edges', body: box(id), edges: [{ along: [0, 0, 1] }], distance: 0.01 }] }));
    expect(corner.error.code).toBe('invalid_geometry');
    const post = addBox([3, 0, 0], [3.1, 0.1, 1]);
    const key = api.query({ ...queryAll, kinds: ['edge'], ids: [post], facing: [0, 0, 1], containing: [3, 0, 0.5] }).entities[0]!.ref.edgeKey!;
    await api.apply({ expectedRevision: api.revision, label: 'Bevel', operations: [{ op: 'chamfer_edges', body: box(post), edges: [key], distance: 0.01 }] });
    expect(volumeOf(api, post)).toBeCloseTo(0.01 - 0.01 ** 2 / 2, 9);
    const stale = await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [{ op: 'chamfer_edges', body: box(post), edges: [key], distance: 0.01 }] }));
    expect(stale.error.code).toBe('invalid_reference');
    const before = volumeOf(api, id), depth = host.undoStack.length;
    const big = await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [{ op: 'fillet_edges', body: box(id), edges: [{ along: [1, 0, 0] }], radius: 0.5 }] }));
    expect(big.error.code).toBe('invalid_geometry');
    expect(volumeOf(api, id)).toBeCloseTo(before);
    expect(host.undoStack.length).toBe(depth);
  });

  it('draws an arched top with an arc, a raised panel with an inward offset, and rounded corners', async () => {
    const { api, root } = setup();
    const result = await api.apply({ expectedRevision: api.revision, label: 'Shapes', operations: [
      { op: 'add_arc', center: [0.5, 1, 0], normal: [0, 0, 1], radius: 0.5, startDeg: 0, endDeg: 180, segments: 12 },
      { op: 'add_polyline', as: 'arched', points: [[0, 1, 0], [0, 0, 0], [1, 0, 0], [1, 1, 0]] },
      { op: 'push_pull', as: 'top', face: '$arched', distance: 0.1 },
      { op: 'add_rectangle', as: 'panel', corner: [5, 0, 0], side1: [1, 0, 0], side2: [0, 1, 0] },
      { op: 'offset', as: 'field', face: '$panel', distance: -0.1 },
      { op: 'push_pull', as: 'raised', face: '$field', distance: 0.05 },
      { op: 'add_rectangle', as: 'round', corner: [10, 0, 0], side1: [1, 0, 0], side2: [0, 1, 0] },
      { op: 'fillet_corner', corner: [10, 0, 0], radius: 0.2 },
      { op: 'push_pull', as: 'rounded', face: '$round', distance: 0.1 },
    ] });
    const half = 0.5 * 0.25 * 12 * Math.sin(Math.PI / 12);
    expect(root().bodies.get(result.created.top as never)!.props.volume).toBeCloseTo((1 + half) * 0.1, 6);
    expect(root().bodies.get(result.created.raised as never)!.props.volume).toBeCloseTo(0.8 * 0.8 * 0.05, 6);
    const rounded = root().bodies.get(result.created.rounded as never)!.props.volume;
    expect(rounded).toBeLessThan(0.1);
    expect(rounded).toBeGreaterThan(0.1 - 0.04 * 0.1);
  });

  it('mirrors a copy across a plane, draws lines where solids pass through faces, and softens edges', async () => {
    const { api, root, addBox } = setup();
    const a = addBox([1, 0, 0], [2, 1, 1]);
    const mirrored = await api.apply({ expectedRevision: api.revision, label: 'Mirror', operations: [{ op: 'mirror', refs: [box(a)], origin: [0, 0, 0], normal: [1, 0, 0], copy: true }] });
    const copy = mirrored.results[0]!.refs![0]!.id;
    expect(api.query({ ...queryAll, kinds: ['body'], ids: [copy] }).entities[0]!.bounds).toMatchObject({ min: [-2, 0, 0], max: [-1, 1, 1] });
    expect(root().bodies.get(copy as never)!.props.volume).toBeCloseTo(1);
    const b = addBox([1.5, 0.25, 0.5], [3, 0.75, 1.5]);
    const cut = await api.apply({ expectedRevision: api.revision, label: 'Lines', operations: [{ op: 'intersect_faces', refs: [{ body: a, facing: [0, 0, 1] }], with: [box(b)] }] });
    expect(cut.results[0]!.count).toBe(1);
    expect(root().bodies.get(a as never)!.imprints.size).toBe(1);
    const prism = await api.apply({ expectedRevision: api.revision, label: 'Post', operations: [
      { op: 'add_polygon', as: 'oct', center: [10, 0, 0], normal: [0, 0, 1], radius: 0.1, sides: 16 },
      { op: 'push_pull', as: 'post', face: '$oct', distance: 1 },
      { op: 'soften_edges', refs: ['$post'], angleDeg: 30 },
    ] });
    expect(prism.results[2]!.count).toBe(16);
  });

  it('adds guides, a dimension, text and a section plane that the query lists', async () => {
    const { api, root } = setup();
    const result = await api.apply({ expectedRevision: api.revision, label: 'Notes', operations: [
      { op: 'add_guide', as: 'g1', point: [0, 0, 0], direction: [1, 0, 0] },
      { op: 'add_guide', point: [0, 0, 1], end: [1, 0, 1] },
      { op: 'add_guide', point: [2, 2, 2] },
      { op: 'add_dimension', as: 'd', start: [0, 0, 0], end: [0.9144, 0, 0], offset: [0, -0.1, 0] },
      { op: 'add_text', as: 't', text: 'Toe kick', anchor: [0.5, 0, 0.05] },
      { op: 'add_text', text: 'Base cabinet', screen: [0.05, 0.05] },
      { op: 'add_section_plane', as: 'cut', point: [0.5, 0, 0], normal: [1, 0, 0], name: 'Center' },
      { op: 'set_section_plane', plane: '$cut', hidden: true },
    ] });
    expect(root().guides.size).toBe(3);
    expect(api.query({ ...queryAll, kinds: ['dimension'] }).entities[0]).toMatchObject({ ref: { id: result.created.d }, points: [[0, 0, 0], [0.9144, 0, 0]] });
    expect(api.query({ ...queryAll, kinds: ['text'] }).entities.map(t => t.text).sort()).toEqual(['Base cabinet', 'Toe kick']);
    expect(api.query({ ...queryAll, kinds: ['sectionPlane'] }).entities[0]).toMatchObject({ ref: { id: result.created.cut }, name: 'Center', active: true, hidden: true, normal: [1, 0, 0] });
    const along = await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [{ op: 'add_dimension', start: [0, 0, 0], end: [1, 0, 0], offset: [2, 0, 0] }] }));
    expect(along.error.code).toBe('invalid_operation');
  });

  it('adds a library wood, turns its grain on a solid, and edits a material', async () => {
    const { api, root, addBox } = setup();
    const id = addBox([0, 0, 0], [0.05, 0.02, 0.7]);
    const result = await api.apply({ expectedRevision: api.revision, label: 'Oak stile', operations: [
      { op: 'add_material', as: 'oak', library: 'Wood_Oak' },
      { op: 'paint', refs: [box(id)], materialId: '$oak' },
      { op: 'set_texture', refs: [box(id)], grain: [0, 0, 1] },
      { op: 'set_material', materialId: '$oak', name: 'Quartersawn oak', opacity: 0.9 },
    ] });
    expect(result.results[2]!.count).toBe(4);
    const body = root().bodies.get(id as never)!;
    expect([...body.faces.values()].filter(f => f.uv.kind === 'sized')).toHaveLength(4);
    expect(api.getDocument().materials.find(m => m.id === result.created.oak)).toMatchObject({ name: 'Quartersawn oak', opacity: 0.9 });
    const unknown = await failure(() => api.apply({ expectedRevision: api.revision, label: 'x', operations: [{ op: 'add_material', library: 'Wood_Unobtainium' }] }));
    expect(unknown.error.code).toBe('invalid_reference');
    const library = await runModelTool(api, MODEL_TOOLS.materialLibrary.name, { category: 'wood' });
    expect(JSON.parse(library.content).materials.some((m: { key: string }) => m.key === 'Wood_Walnut')).toBe(true);
    expect(JSON.parse((await runModelTool(api, MODEL_TOOLS.materialLibrary.name, { category: null })).content).categories.length).toBeGreaterThan(5);
  });

  it('runs the visible grain along the requested direction whichever way the wood image runs', async () => {
    // White Oak's image grain runs down its height, Cherry's across its width; both must show vertical grain on a stile.
    for (const library of ['Wood_Oak', 'Wood_Cherry']) {
      const { api, host, root, addBox } = setup();
      const id = addBox([0, 0, 0], [0.05, 0.02, 0.7]);
      const result = await api.apply({ expectedRevision: api.revision, label: 'Stile', operations: [
        { op: 'add_material', as: 'wood', library },
        { op: 'paint', refs: [box(id)], materialId: '$wood' },
        { op: 'set_texture', refs: [box(id)], grain: [0, 0, 1] },
      ] });
      expect(result.results[2]).toMatchObject({ count: 4, skipped: [{ reason: 'end_grain' }, { reason: 'end_grain' }] });
      const material = api.getDocument().materials.find(m => m.id === result.created.wood)!;
      expect(material.grain, library).toBe(library === 'Wood_Oak' ? 'height' : 'width');
      // In the texture's own coordinates, moving up the front face moves along the image's grain axis only.
      const face = [...root().bodies.get(id as never)!.faces.values()].find(f => f.plane.n[1] < -0.9)!;
      const texture = host.doc.state.materials.get(result.created.wood as never)!.texture!;
      const at = (p: [number, number, number]) => { const [u, v] = basisToLocal(face.basis, p); return uvAt(face.uv, texture.widthM, texture.heightM, u, v); };
      const [s0, t0] = at([0.02, 0, 0.1]), [s1, t1] = at([0.02, 0, 0.6]);
      const along = library === 'Wood_Oak' ? Math.abs(t1 - t0) : Math.abs(s1 - s0), across = library === 'Wood_Oak' ? Math.abs(s1 - s0) : Math.abs(t1 - t0);
      expect(along, library).toBeGreaterThan(0.1);
      expect(across, library).toBeLessThan(1e-9);
      const front = api.query({ ...queryAll, kinds: ['face'], facing: [0, -1, 0] }).entities[0]!;
      expect(front.grain, library).toEqual([0, 0, 1]);
      expect(front.defaultPlacement).toBe(false);
      const side = api.query({ ...queryAll, kinds: ['face'], facing: [1, 0, 0] }).entities[0]!;
      expect(side.grain, library).toEqual([0, 0, 1]);
    }
  });

  it('reports the default grain, skips patterns and untextured faces, and turns grain across a rail', async () => {
    const { api, addBox } = setup();
    const rail = addBox([0, 0, 0], [0.5, 0.02, 0.06]), floor = addBox([1, 0, 0], [2, 1, 0.02]), plain = addBox([3, 0, 0], [3.1, 0.1, 0.1]);
    const result = await api.apply({ expectedRevision: api.revision, label: 'Finish', operations: [
      { op: 'add_material', as: 'oak', library: 'Wood_Oak' },
      { op: 'add_material', as: 'parquet', library: 'Wood_herringbone_parquet' },
      { op: 'paint', refs: [box(rail)], materialId: '$oak' },
      { op: 'paint', refs: [box(floor)], materialId: '$parquet' },
    ] });
    const front = () => api.query({ ...queryAll, kinds: ['face'], ids: [rail], facing: [0, -1, 0] }).entities[0]!;
    expect(front().defaultPlacement).toBe(true);
    expect(front().grain).toHaveLength(3);
    const turned = await api.apply({ expectedRevision: api.revision, label: 'Grain', operations: [
      { op: 'set_texture', refs: [box(rail)], grain: [1, 0, 0] },
      { op: 'set_texture', refs: [box(floor), box(plain)], grain: [1, 0, 0] },
    ] });
    expect(front().grain).toEqual([1, 0, 0]);
    expect(turned.results[1]!.count).toBe(0);
    const reasons = turned.results[1]!.skipped!.map(s => `${s.ref.id}:${s.reason}`);
    expect(reasons.filter(r => r === `${floor}:no_grain`)).toHaveLength(6);
    expect(reasons.filter(r => r === `${plain}:no_texture`)).toHaveLength(6);
    const parquet = api.query({ ...queryAll, kinds: ['face'], ids: [floor], facing: [0, 0, 1] }).entities[0]!;
    expect(parquet).toMatchObject({ grain: null, defaultPlacement: true });
    expect(api.query({ ...queryAll, kinds: ['face'], ids: [plain], facing: [0, 0, 1] }).entities[0]!.grain).toBeUndefined();
    expect(api.getDocument().materials.find(m => m.id === result.created.parquet)!.grain).toBe('none');
    const library = JSON.parse((await runModelTool(api, MODEL_TOOLS.materialLibrary.name, { category: 'wood' })).content) as { materials: { key: string; grain: string }[] };
    expect(library.materials.find(m => m.key === 'Wood_sapele_veneer')!.grain).toBe('height');
  });

  it('adds 3D lettering as a component, or reports that fonts are unavailable', async () => {
    const { api, root } = setup({ fonts: true });
    const result = await api.apply({ expectedRevision: api.revision, label: 'Sign', operations: [{ op: 'add_3d_text', as: 'sign', text: 'OAK', position: [0, 0, 0], height: 0.05, extrude: 0.005 }] });
    const inst = root().instances.get(result.created.sign as never)!;
    expect(api.getDocument().definitions.find(d => d.id === inst.definitionId)!.solids).toBeGreaterThanOrEqual(3);
    const bare = setup();
    const error = await failure(() => bare.api.apply({ expectedRevision: bare.api.revision, label: 'x', operations: [{ op: 'add_3d_text', text: 'A', position: [0, 0, 0] }] }));
    expect(error.error.code).toBe('unavailable');
  });

  it('finds solids that interpenetrate, through groups, and ignores ones that only touch', async () => {
    const { api, addBox } = setup();
    const a = addBox([0, 0, 0], [1, 1, 1]), b = addBox([0.9, 0, 0], [2, 1, 1]), c = addBox([2, 0, 0], [3, 1, 1]);
    await api.apply({ expectedRevision: api.revision, label: 'Group', operations: [
      { op: 'make_group', as: 'inner', refs: [box(b)] }, { op: 'rename_instance', ref: '$inner', name: 'Rail' }, { op: 'make_group', refs: ['$inner'] }] });
    const result = await api.findOverlaps({ container: null, minVolume: null });
    expect(result.solids).toBe(3);
    expect(result.overlaps).toHaveLength(1);
    expect(result.overlaps[0]).toMatchObject({ a: { kind: 'body', id: a, path: [] }, b: { kind: 'body', name: 'Rail' } });
    expect(result.overlaps[0]!.volume).toBeCloseTo(0.1, 6);
    expect(result.overlaps[0]!.bounds.min[0]).toBeCloseTo(0.9);
    expect(result.overlaps.some(o => o.a.id === c || o.b.id === c)).toBe(false);
    expect(JSON.parse((await runModelTool(api, MODEL_TOOLS.overlaps.name, { container: null, minVolume: 1 })).content).overlaps).toEqual([]);
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
