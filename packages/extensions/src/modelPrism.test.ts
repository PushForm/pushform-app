// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { CommandRegistry, DocumentHost, SERVICE_DOCUMENT, SERVICE_KERNEL, guideCommands, modelCommands, transformCommands } from '@pushform/commands';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import type { Id } from '@pushform/core';
import { ModelDocumentApi } from './modelApi';

const kernels: KernelClient[] = [];
afterEach(() => { for (const kernel of kernels.splice(0)) kernel.dispose(); });
const rectangle = [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
function setup() {
  const host = new DocumentHost(), kernel = new KernelClient(new InlineBackend()); kernels.push(kernel);
  const commands = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  commands.registerAll([...modelCommands, ...transformCommands, ...guideCommands]);
  const api = new ModelDocumentApi(commands, 'Part tools');
  const run = (operation: Record<string, unknown>) => api.apply({ expectedRevision: api.revision, label: 'Draw part', operations: [{ op: 'add_prism', as: 'part', points: rectangle, normal: [0, 0, 1], distance: 0.1, ...operation }] });
  return { host, api, commands, run, root: () => host.doc.rootDefinition.entities };
}
describe('independent profile solids', () => {
  it('supports an oblique local extrusion and an affine reference frame for transformed assemblies', async () => {
    const s = setup(), result = await s.run({ points: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], extrusionDirection: [1, 0, 1], distance: Math.sqrt(2) * 0.1,
      referenceFrame: [1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1] });
    const body = s.root().bodies.get(result.created.part as Id)!;
    expect(body.props.volume).toBeCloseTo(0.1); expect(body.referenceFrame?.slice(8, 11)).toEqual([1, 0, 1]);
    expect(Math.max(...Array.from(body.mesh.verts).filter((_, index) => index % 3 === 0))).toBeCloseTo(1.1);
  });
  it('commits high-segment construction guides through one document change and one Undo entry', async () => {
    const s = setup(), events: unknown[] = []; s.host.doc.events.on('change', event => events.push(event));
    const segments = Array.from({ length: 768 }, (_, i) => [[i / 1000, 0, 0], [i / 1000, 0.1, 0]]);
    await s.api.apply({ expectedRevision: s.api.revision, label: 'Construction', operations: [{ op: 'add_guides', segments }] });
    expect(s.root().guides.size).toBe(768); expect(s.root().bodies.size).toBe(0); expect(events).toHaveLength(1);
    s.host.undo(); expect(s.root().guides.size).toBe(0);
  });
  it('creates a concave solid with a through hole on an existing body without imprinting it; one Undo removes only the part', async () => {
    const s = setup();
    const originalId = s.commands.execute('model.addBox', { min: [-1, -1, 0], max: [3, 3, 1] }) as Id;
    const original = s.root().bodies.get(originalId)!, mesh = original.mesh, imprints = original.imprints, undo = s.host.undoStack.length;
    const result = await s.run({ points: [[0, 0, 1], [2, 0, 1], [2, 1, 1], [1, 1, 1], [1, 2, 1], [0, 2, 1]],
      holes: [[[0.2, 0.2, 1], [0.8, 0.2, 1], [0.8, 0.8, 1], [0.2, 0.8, 1]]] });
    expect(s.root().bodies.size).toBe(2); expect(s.root().sketch.edges.size).toBe(0);
    expect(s.root().bodies.get(originalId)!.mesh).toBe(mesh); expect(s.root().bodies.get(originalId)!.imprints).toBe(imprints);
    expect(s.root().bodies.get(result.created.part as Id)!.props.volume).toBeCloseTo((3 - 0.36) * 0.1);
    expect(s.host.undoStack.length).toBe(undo + 1); s.host.undo(); expect([...s.root().bodies.keys()]).toEqual([originalId]);
  });
  it('preserves an oriented reference frame and accepts signed thickness with an explicit non-unit normal', async () => {
    const s = setup(), result = await s.run({ points: [[1, 2, 3], [1, 3, 3], [1, 3, 5], [1, 2, 5]], normal: [2, 0, 0], distance: -0.2 });
    const body = s.root().bodies.get(result.created.part as Id)!;
    expect(body.props.volume).toBeCloseTo(0.4);
    expect(body.referenceFrame).toEqual([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 2, 3, 1]);
    expect(Math.min(...Array.from(body.mesh.verts).filter((_, index) => index % 3 === 0))).toBeCloseTo(0.8);
  });
  it('smooths the side joins of a round profile while retaining its cap boundaries', async () => {
    const s = setup(), points = Array.from({ length: 24 }, (_, i) => [Math.cos(i * Math.PI / 12), Math.sin(i * Math.PI / 12), 0]);
    const result = await s.run({ points, smoothSides: true });
    const body = s.root().bodies.get(result.created.part as Id)!;
    const edges = [...body.edges.values()];
    expect(edges.filter(edge => edge.smooth && edge.soft)).toHaveLength(24);
    expect(edges.filter(edge => !edge.smooth)).toHaveLength(48);
  });
  it.each([
    { distance: 0 },
    { points: [[0, 0, 0], [1, 0, 0], [1, 1, 0.01], [0, 1, 0]] },
    { points: [[0, 0, 0], [2, 2, 0], [0, 2, 0], [2, 0, 0]] },
    { holes: [[[2, 2, 1], [3, 2, 1], [3, 3, 1], [2, 3, 1]]] },
    { holes: [[[0, 0.2, 1], [0.5, 0.2, 1], [0.5, 0.8, 1], [0, 0.8, 1]]] },
  ])('rejects malformed profile/thickness atomically: %j', async operation => {
    const s = setup(); await expect(s.run(operation)).rejects.toBeDefined();
    expect(s.root().bodies.size).toBe(0); expect(s.root().sketch.edges.size).toBe(0); expect(s.host.canUndo()).toBe(false);
  });
  it('cancels a pending extrusion without leaving a new body or sketch residue', async () => {
    const s = setup(), controller = new AbortController();
    const pending = s.api.apply({ expectedRevision: s.api.revision, label: 'Draw part', operations: [{ op: 'add_prism', points: rectangle, normal: [0, 0, 1], distance: 0.1 }] }, controller.signal);
    controller.abort(); await expect(pending).rejects.toMatchObject({ error: { code: 'cancelled' } });
    expect(s.root().bodies.size).toBe(0); expect(s.root().sketch.edges.size).toBe(0); expect(s.host.canUndo()).toBe(false);
  });
});


it('applies a finite affine normal stretch with identity and one amended Undo; rejects singular/projective matrices', async () => {
  const s = setup(), result = await s.run({}); const id = result.created.part as Id;
  const before = s.root().bodies.get(id)!;
  const matrix = [1,0,0,0, 0,1,0,0, 0.5,0,2,0, -0.5,0,-1,1];
  await s.api.apply({ expectedRevision: s.api.revision, label: 'Correct thickness', operations: [{ op: 'transform', refs: [{ kind: 'body', id }], matrix }] }, undefined, undefined, undefined, true);
  const body = s.root().bodies.get(id)!; expect(body.id).toBe(before.id); expect(body.valid).toBe(true); expect(body.props.volume).toBeCloseTo(0.2);
  expect(s.host.undoStack.length).toBe(1);
  for (const invalid of [[...matrix.slice(0,15),0], [0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]]) {
    await expect(s.api.apply({ expectedRevision: s.api.revision, label: 'Invalid', operations: [{ op: 'transform', refs: [{ kind: 'body', id }], matrix: invalid }] })).rejects.toBeDefined();
    expect(s.root().bodies.get(id)).toBe(body);
  }
  s.host.undo(); expect(s.root().bodies.size).toBe(0);
});


it('retains both closed circular rims and the curved side group through thickness correction, then marks a deformed rim truthfully', async () => {
  const s = setup(), points = Array.from({ length: 32 }, (_,i) => [Math.cos(i*Math.PI/16),Math.sin(i*Math.PI/16),0]);
  const result = await s.run({ points, closedCurve: true, smoothSides: false }), id = result.created.part as Id;
  const inspect = () => s.root().bodies.get(id)!;
  expect(inspect().curves.size).toBe(2); expect([...inspect().curves.values()].map(c=>[c.kind,c.radius,c.edgeRefs.length])).toEqual([['circle',1,32],['circle',1,32]]);
  expect([...inspect().surfaces.values()].map(surface=>surface.faceIds.length)).toEqual([32]);
  expect([...inspect().edges.values()].filter(edge=>edge.curveId!==null)).toHaveLength(64);
  const curves = [...inspect().curves.keys()];
  await s.api.apply({ expectedRevision: s.api.revision, label: 'Thicker', operations: [{ op:'scale', refs:[{kind:'body',id}], origin:[0,0,0], factors:[1,1,2] }] });
  expect([...inspect().curves.values()].every(curve=>curve.kind==='circle'&&Math.abs(curve.radius-1)<1e-9)).toBe(true); expect([...inspect().curves.keys()]).toEqual(curves);
  const centers = [...inspect().curves.values()].map(curve=>curve.center[2]).sort((a,b)=>a-b); expect(centers[0]).toBeCloseTo(0,10); expect(centers[1]).toBeCloseTo(0.2,10);
  await s.api.apply({ expectedRevision:s.api.revision,label:'Deform',operations:[{op:'scale',refs:[{kind:'body',id}],origin:[0,0,0],factors:[2,1,1]}] });
  expect([...inspect().curves.values()].map(curve=>[curve.kind,curve.radius,curve.edgeRefs.length])).toEqual([['freehand',0,32],['freehand',0,32]]);
});
it('groups exact affine-deformed profile rims without inventing circular radii', async () => {
  const s=setup(), points=Array.from({length:24},(_,i)=>[2*Math.cos(i*Math.PI/12),Math.sin(i*Math.PI/12),0]);
  const result=await s.run({points,closedCurve:true,smoothSides:true});const body=s.root().bodies.get(result.created.part as Id)!;
  expect([...body.curves.values()].map(c=>[c.kind,c.edgeRefs.length])).toEqual([['freehand',24],['freehand',24]]);
  expect([...body.surfaces.values()][0]!.faceIds).toHaveLength(24);
});
