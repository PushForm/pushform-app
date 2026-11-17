// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox } from '@pushform/core';
import type { Id } from '@pushform/core';
import { bodyFromMesh } from '@pushform/model';
import type { EntityRef } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT } from '../host/services';
import { sketchCommands } from './sketch';
import { connectedSketchRefs } from './sketchQueries';

function setup() {
  const host = new DocumentHost();
  const registry = new CommandRegistry({ tx: host, services: new Map([[SERVICE_DOCUMENT, host]]) });
  registry.registerAll(editCommands);
  registry.registerAll(sketchCommands);
  const sketch = () => host.doc.rootDefinition.entities.sketch;
  const rect = () =>
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] }) as number[];
  return { host, registry, sketch, rect };
}

const edgeRef = (id: number): EntityRef => ({ kind: 'sketchEdge', path: [], id: id as Id });

describe('sketch.* commands', () => {
  it('Select All and Invert take every visible kind in the open context and skip hidden ones', () => {
    const { host, registry, rect } = setup();
    rect();
    const visibleBody = host.doc.transact('bodies', (d) => {
      const root = d.definitions.get(d.rootDefinitionId)!.entities;
      const shown = bodyFromMesh(d, meshBox([2, 0, 0], [3, 1, 1]), { container: root as never }).id;
      const hidden = bodyFromMesh(d, meshBox([4, 0, 0], [5, 1, 1]), { container: root as never });
      hidden.hidden = true;
      const base = { tagId: d.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} };
      const g = d.meta.nextId++ as Id, t = d.meta.nextId++ as Id, sp = d.meta.nextId++ as Id;
      root.guides.set(g, { ...base, id: g, kind: 'point', origin: [0, 0, 2] } as never);
      root.texts.set(t, { ...base, id: t, kind: 'leader', text: 'Note', position: [0, 0, 0], offset: [1, 0, 0], leader: 'pushpin', fontFamily: 'Arial', fontSizePt: 12, color: [0, 0, 0] } as never);
      root.sectionPlanes.set(sp, { ...base, id: sp, name: 'Section 1', symbol: '1', plane: { n: [0, 0, -1], d: 0.5 }, origin: [0, 0, 0.5] } as never);
      return shown;
    }).value;
    registry.execute('edit.selectAll', {});
    const kinds = host.selection.refs.map((r) => r.kind).sort();
    expect(kinds).toEqual(['body', 'guide', 'sectionPlane', 'sketchEdge', 'sketchEdge', 'sketchEdge', 'sketchEdge', 'sketchFace', 'text']);
    expect(host.selection.refs.find((r) => r.kind === 'body')?.id).toBe(visibleBody);
    // with hidden geometry shown, the hidden solid counts too
    host.doc.transact('show hidden', (d) => { d.styles.get(d.activeStyleId)!.modeling.hiddenGeometry = true; });
    registry.execute('edit.selectAll', {});
    expect(host.selection.refs.filter((r) => r.kind === 'body')).toHaveLength(2);
    // Invert takes the rest of what is visible
    host.selection.set([{ kind: 'body', path: [], id: visibleBody }]);
    registry.execute('edit.invertSelection', {});
    expect(host.selection.refs.some((r) => r.kind === 'body' && r.id === visibleBody)).toBe(false);
    expect(host.selection.refs.some((r) => r.kind === 'text')).toBe(true);
  });

  it('addEdge / addPolyline / rectangle build faces inside one undo step each', () => {
    const { registry, sketch, host, rect } = setup();
    const ids = registry.execute('sketch.addEdge', { a: [0, 0, 0], b: [1, 0, 0] }) as number[];
    expect(ids).toHaveLength(1);
    expect(sketch().edges.size).toBe(1);
    host.undo();
    expect(sketch().edges.size).toBe(0);
    registry.execute('sketch.addPolyline', { points: [[0, 0, 0], [2, 0, 0], [2, 2, 0]], closed: true });
    expect(sketch().edges.size).toBe(3);
    expect(sketch().faces.size).toBe(1);
    expect(host.undoStack.length).toBe(1);
    host.undo();
    expect(rect()).toHaveLength(4);
    expect(sketch().faces.size).toBe(1);
    expect(host.undoStack.length).toBe(1);
    expect(() => registry.execute('sketch.addEdge', { a: [0, 0], b: [1, 0, 0] })).toThrow(/Invalid params/);
  });

  it('eraseEdge removes bounded faces, eraseFace keeps edges, setEdgeFlags toggles flags', () => {
    const { registry, sketch, rect } = setup();
    const ids = rect();
    registry.execute('sketch.eraseFace', { id: [...sketch().faces.keys()][0] });
    expect(sketch().faces.size).toBe(0);
    expect(sketch().edges.size).toBe(4);
    registry.execute('sketch.setEdgeFlags', { ids: [ids[0]], soft: true, hidden: true });
    expect(sketch().edges.get(ids[0] as Id)).toMatchObject({ soft: true, smooth: false, hidden: true });
    expect(registry.execute('sketch.eraseEdge', { id: ids[0] })).toBe(true);
    expect(registry.execute('sketch.eraseEdge', { id: ids[0] })).toBe(false);
    expect(registry.execute('sketch.eraseEdges', { ids: [ids[1], ids[2]] })).toBe(2);
    expect(sketch().edges.size).toBe(1);
  });
});

describe('edit.* and selection.* commands', () => {
  it('edit.delete erases selected sketch edges with their faces, bodies, and reports skipped body faces', () => {
    const { registry, sketch, host, rect } = setup();
    const ids = rect();
    const bodyId = host.edit('box', (d) => {
      const root = d.definitions.get(d.rootDefinitionId)!;
      return bodyFromMesh(d, meshBox([2, 2, 0], [3, 3, 1]), { container: root.entities }).id;
    });
    expect(registry.isEnabled('edit.delete')).toBe(false);
    host.selection.set([edgeRef(ids[0]!), { kind: 'body', path: [], id: bodyId }]);
    expect(registry.isEnabled('edit.delete')).toBe(true);
    const before = host.undoStack.length;
    const res = registry.execute('edit.delete');
    expect(res).toEqual({ removed: 2, skipped: 0, message: null });
    expect(sketch().edges.size).toBe(3);
    expect(sketch().faces.size).toBe(0);
    expect(host.doc.rootDefinition.entities.bodies.size).toBe(0);
    expect(host.selection.isEmpty).toBe(true);
    expect(host.undoStack.length).toBe(before + 1);
    host.undo();
    expect(sketch().edges.size).toBe(4);
    expect(sketch().faces.size).toBe(1);
    expect(host.doc.rootDefinition.entities.bodies.size).toBe(1);
    expect(host.selection.size).toBe(2); // selection snapshot restored by undo
    host.selection.set([{ kind: 'face', path: [], id: bodyId, faceId: 0 as never, region: null }]);
    expect(registry.execute('edit.delete')).toMatchObject({ removed: 0, skipped: 1 });
    expect(host.doc.rootDefinition.entities.bodies.size).toBe(1);
  });

  it('selectAll / selectNone / invertSelection cover sketch entities and bodies', () => {
    const { registry, host, rect } = setup();
    const ids = rect();
    expect(registry.execute('edit.selectAll')).toBe(5);
    registry.execute('selection.remove', { refs: [edgeRef(ids[0]!)] });
    expect(host.selection.size).toBe(4);
    expect(registry.execute('edit.invertSelection')).toBe(1);
    expect(host.selection.refs).toEqual([edgeRef(ids[0]!)]);
    registry.execute('edit.selectNone');
    expect(host.selection.isEmpty).toBe(true);
  });

  it('selection.set/add/remove/toggle validate refs, notify and never touch the undo stack', () => {
    const { registry, host, rect } = setup();
    const ids = rect();
    const events: number[] = [];
    host.selection.events.on('change', (e) => events.push(e.refs.length));
    registry.execute('selection.set', { refs: [edgeRef(ids[0]!)] });
    registry.execute('selection.add', { refs: [edgeRef(ids[1]!), edgeRef(ids[0]!)] });
    registry.execute('selection.toggle', { refs: [edgeRef(ids[1]!), edgeRef(ids[2]!)] });
    registry.execute('selection.remove', { refs: [edgeRef(ids[2]!)] });
    expect(events).toEqual([1, 2, 2, 1]);
    expect(host.selection.refs).toEqual([edgeRef(ids[0]!)]);
    expect(host.undoStack.length).toBe(1);
    expect(() => registry.execute('selection.set', { refs: [{ kind: 'nope', path: [], id: 1 }] })).toThrow(/Invalid params/);
    expect(() => registry.execute('selection.set', { refs: [{ kind: 'edge', path: [], id: 1, edgeKey: 'x' }] })).toThrow(
      /Invalid params/,
    );
  });

  it('connectedSketchRefs walks shared vertices and includes fully contained faces', () => {
    const { registry, sketch, rect } = setup();
    const ids = rect();
    registry.execute('sketch.addEdge', { a: [1, 1, 0], b: [2, 2, 0] });
    registry.execute('sketch.addEdge', { a: [5, 5, 0], b: [6, 6, 0] });
    const refs = connectedSketchRefs(sketch(), edgeRef(ids[0]!));
    expect(refs.filter((r) => r.kind === 'sketchEdge')).toHaveLength(5);
    expect(refs.filter((r) => r.kind === 'sketchFace')).toHaveLength(1);
  });
});
