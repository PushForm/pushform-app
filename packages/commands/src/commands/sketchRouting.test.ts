// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { basisToWorld, meshBox } from '@pushform/core';
import type { Id } from '@pushform/core';
import { bodyFromMesh, computeRegions, type EntityContainer } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT } from '../host/services';
import { sketchCommands } from './sketch';
import { groupCommands } from './groups';
import { contextCommands } from './context';

function setup() {
  const host = new DocumentHost();
  const commands = new CommandRegistry({ tx: host, services: new Map([[SERVICE_DOCUMENT, host]]) });
  commands.registerAll(sketchCommands);
  let bodyId = 0 as Id;
  host.doc.transact('box', (draft) => {
    const root = draft.definitions.get(draft.rootDefinitionId)!;
    bodyId = bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: root.entities }).id;
  });
  return { host, commands, bodyId };
}

describe('sketch routing onto body faces', () => {
  it('a rectangle drawn on a face becomes imprint edges that split it into regions', () => {
    const { host, commands, bodyId } = setup();
    commands.execute('sketch.rectangle', { a: [0.2, 0.2, 1], b: [0.6, 0.2, 1], c: [0.6, 0.6, 1], d: [0.2, 0.6, 1] });
    const body = host.doc.rootDefinition.entities.bodies.get(bodyId)!;
    expect(host.doc.rootDefinition.entities.sketch.edges.size).toBe(0);
    expect(body.imprints.size).toBe(1);
    const [faceId, g] = [...body.imprints][0]!;
    expect(g.edges.size).toBe(4);
    expect(computeRegions(body, faceId)).toHaveLength(2);
    expect(host.undoStack.length).toBe(1);
    host.undo();
    expect(host.doc.rootDefinition.entities.bodies.get(bodyId)!.imprints.size).toBe(0);
  });

  it('a line leaving the face is clipped: the part on the face imprints, the rest stays sketch', () => {
    const { host, commands, bodyId } = setup();
    commands.execute('sketch.addEdge', { a: [0.5, 0.5, 1], b: [2, 0.5, 1] });
    const root = host.doc.rootDefinition.entities;
    const body = root.bodies.get(bodyId)!;
    const [faceId, g] = [...body.imprints][0]!;
    expect(g.edges.size).toBe(1);
    const imprint = [...g.edges.values()][0]!;
    const uv = [g.vertices.get(imprint.a)!, g.vertices.get(imprint.b)!];
    const face = body.faces.get(faceId)!;
    const ends = uv.map(([u, v]) => basisToWorld(face.basis, u!, v!).map((x) => +x.toFixed(9))).sort((p, q) => p[0]! - q[0]!);
    expect(ends).toEqual([[0.5, 0.5, 1], [1, 0.5, 1]]);
    // the outside part is sketch, meeting the imprint at the face's edge
    expect(sketchSegments(root)).toEqual([[[1, 0.5, 1], [2, 0.5, 1]]]);
    expect(host.undoStack.length).toBe(1);
    host.undo();
    expect(host.doc.rootDefinition.entities.sketch.edges.size).toBe(0);
    expect(host.doc.rootDefinition.entities.bodies.get(bodyId)!.imprints.size).toBe(0);
  });

  it('a line across a face splits it into regions and keeps both outside parts as sketch', () => {
    const { host, commands, bodyId } = setup();
    commands.execute('sketch.addEdge', { a: [-1, 0.5, 1], b: [2, 0.5, 1] });
    const root = host.doc.rootDefinition.entities;
    const body = root.bodies.get(bodyId)!;
    const [faceId] = [...body.imprints][0]!;
    expect(computeRegions(body, faceId)).toHaveLength(2);
    expect(sketchSegments(root)).toEqual([[[-1, 0.5, 1], [0, 0.5, 1]], [[1, 0.5, 1], [2, 0.5, 1]]]);
  });

  it('a line crossing the faces of two solids imprints on each and is sketch between them', () => {
    const { host, commands, bodyId } = setup();
    let second = 0 as Id;
    host.doc.transact('second box', (draft) => {
      const root = draft.definitions.get(draft.rootDefinitionId)!;
      second = bodyFromMesh(draft, meshBox([2, 0, 0], [3, 1, 1]), { container: root.entities }).id;
    });
    commands.execute('sketch.addEdge', { a: [0.5, 0.5, 1], b: [2.5, 0.5, 1] });
    const root = host.doc.rootDefinition.entities;
    expect(root.bodies.get(bodyId)!.imprints.size).toBe(1);
    expect(root.bodies.get(second)!.imprints.size).toBe(1);
    expect(sketchSegments(root)).toEqual([[[1, 0.5, 1], [2, 0.5, 1]]]);
  });

  it('a line that only touches a face at one end, or leaves its plane, stays sketch', () => {
    const { host, commands, bodyId } = setup();
    commands.execute('sketch.addEdge', { a: [0.5, 0.5, 1], b: [0.5, 0.5, 2] });
    commands.execute('sketch.addEdge', { a: [1, 0.5, 1], b: [2, 0.5, 1] });
    expect(host.doc.rootDefinition.entities.bodies.get(bodyId)!.imprints.size).toBe(0);
    expect(host.doc.rootDefinition.entities.sketch.edges.size).toBe(2);
  });

  it('does not clip a rectangle drawn partly over a face: it still closes into a sketch face', () => {
    const { host, commands, bodyId } = setup();
    commands.execute('sketch.rectangle', { a: [0.5, 0.5, 1], b: [2, 0.5, 1], c: [2, 2, 1], d: [0.5, 2, 1] });
    const root = host.doc.rootDefinition.entities;
    expect(root.bodies.get(bodyId)!.imprints.size).toBe(0);
    expect(root.sketch.faces.size).toBe(1);
  });

  it('clips in a nested edit context, in its coordinates', () => {
    const { host, commands } = setup();
    commands.registerAll(groupCommands);
    commands.registerAll(contextCommands);
    const root = () => host.doc.rootDefinition.entities;
    const made = commands.execute('group.make', { refs: [{ kind: 'body', path: [], id: [...root().bodies.keys()][0]! }] }) as { instanceId: number };
    host.doc.transact('move group', (draft) => {
      draft.definitions.get(draft.rootDefinitionId)!.entities.instances.get(made.instanceId as Id)!.transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] as never;
    });
    commands.execute('context.enter', { path: [made.instanceId] });
    commands.execute('sketch.addEdge', { a: [5.5, 0.5, 1], b: [7, 0.5, 1] });
    const def = host.doc.state.definitions.get(host.doc.state.definitions.get(host.doc.state.rootDefinitionId)!.entities.instances.get(made.instanceId as Id)!.definitionId)!;
    expect([...def.entities.bodies.values()][0]!.imprints.size).toBe(1);
    expect(sketchSegments(def.entities)).toEqual([[[1, 0.5, 1], [2, 0.5, 1]]]);
  });
});

/** Sketch edges as sorted point pairs, rounded. */
function sketchSegments(c: EntityContainer): number[][][] {
  const r = (p: readonly number[]) => p.map((x) => +x.toFixed(9));
  return [...c.sketch.edges.values()]
    .map((e) => [r(c.sketch.vertices.get(e.a)!.p), r(c.sketch.vertices.get(e.b)!.p)].sort((p, q) => p[0]! - q[0]!))
    .sort((p, q) => p[0]![0]! - q[0]![0]!);
}
