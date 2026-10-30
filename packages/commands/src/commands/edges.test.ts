// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Id } from '@pushform/core';
import type { EntityRef } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT } from '../host/services';
import { modelCommands } from './model';
import { sketchCommands } from './sketch';
import { edgeCommands, softenInfo } from './edges';

function setup() {
  const host = new DocumentHost();
  const registry = new CommandRegistry({ tx: host, services: new Map([[SERVICE_DOCUMENT, host]]) });
  registry.registerAll(editCommands);
  registry.registerAll(modelCommands);
  registry.registerAll(sketchCommands);
  registry.registerAll(edgeCommands);
  const bodyId = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as Id;
  const body = () => host.doc.rootDefinition.entities.bodies.get(bodyId)!;
  const bodyRef: EntityRef = { kind: 'body', path: [], id: bodyId };
  return { host, registry, body, bodyId, bodyRef };
}

describe('edges.soften', () => {
  it('softens body edges whose dihedral angle is at most angleDeg and hardens the rest', () => {
    const { host, registry, body, bodyRef } = setup();
    expect(softenInfo(host.doc.state, [bodyRef])).toEqual({ edges: 12, soft: 0, angleDeg: null, smooth: null, softenCoplanar: null });

    // a box has only 90° edges: 20° softens nothing
    expect(registry.execute('edges.soften', { refs: [bodyRef], angleDeg: 20 })).toEqual({ softened: 0, hardened: 0 });
    expect([...body().edges.values()].every((e) => !e.soft && !e.smooth)).toBe(true);

    // 95° softens (and smooths) every edge, in one undo step
    const before = host.undoStack.length;
    expect(registry.execute('edges.soften', { refs: [bodyRef], angleDeg: 95, smooth: true })).toEqual({ softened: 12, hardened: 0 });
    expect(host.undoStack.length).toBe(before + 1);
    expect([...body().edges.values()].every((e) => e.soft && e.smooth)).toBe(true);
    expect(softenInfo(host.doc.state, [bodyRef])).toMatchObject({ edges: 12, soft: 12, angleDeg: 90, smooth: true });

    // soft without smooth normals
    registry.execute('edges.soften', { refs: [bodyRef], angleDeg: 95, smooth: false });
    expect([...body().edges.values()].every((e) => e.soft && !e.smooth)).toBe(true);
    expect(softenInfo(host.doc.state, [bodyRef]).smooth).toBe(false);

    // lowering the angle hardens again; undo restores
    expect(registry.execute('edges.soften', { refs: [bodyRef], angleDeg: 45 })).toEqual({ softened: 0, hardened: 12 });
    expect(softenInfo(host.doc.state, [bodyRef]).soft).toBe(0);
    host.undo();
    expect(softenInfo(host.doc.state, [bodyRef]).soft).toBe(12);
  });

  it('a face ref covers only its edges; an edge ref only itself; refs default to the selection', () => {
    const { host, registry, body, bodyId } = setup();
    const faceId = body().faces.keys().next().value!;
    registry.execute('edges.soften', { refs: [{ kind: 'face', path: [], id: bodyId, faceId, region: null }], angleDeg: 95 });
    const soft = [...body().edges.values()].filter((e) => e.soft);
    expect(soft).toHaveLength(4);
    expect(soft.every((e) => e.faceA === faceId || e.faceB === faceId)).toBe(true);

    const other = [...body().edges.values()].find((e) => !e.soft)!;
    host.selection.set([{ kind: 'edge', path: [], id: bodyId, edgeKey: other.key }]);
    registry.execute('edges.soften', { angleDeg: 95, smooth: false });
    expect(body().edges.get(other.key)).toMatchObject({ soft: true, smooth: false });
    expect([...body().edges.values()].filter((e) => e.soft)).toHaveLength(5);
  });

  it('sketch edges are flagged directly', () => {
    const { host, registry } = setup();
    const ids = registry.execute('sketch.addEdge', { a: [5, 0, 0], b: [6, 0, 0] }) as number[];
    const ref: EntityRef = { kind: 'sketchEdge', path: [], id: ids[0]! as Id };
    registry.execute('edges.soften', { refs: [ref], angleDeg: 20, smooth: true });
    const edge = () => host.doc.rootDefinition.entities.sketch.edges.get(ref.id)!;
    expect(edge()).toMatchObject({ soft: true, smooth: true });
    expect(softenInfo(host.doc.state, [ref])).toMatchObject({ edges: 1, soft: 1, smooth: true });
    registry.execute('edges.soften', { refs: [ref], angleDeg: 0 });
    expect(edge()).toMatchObject({ soft: false, smooth: false });
  });
});
