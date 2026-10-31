// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox, type Id } from '@pushform/core';
import { createDocument, DraftIdAllocator } from './Document';
import { UndoStack } from './UndoStack';
import { Selection } from './Selection';
import { bodyFromMesh } from './body/BodyBuilder';
import type { EntityRef } from './entities/common';

describe('Document', () => {
  it('creates defaults', () => {
    const doc = createDocument();
    const s = doc.state;
    expect(s.definitions.size).toBe(1);
    expect(doc.rootDefinition.name).toBe('Model');
    expect(s.tags.get(s.defaultTagId)?.name).toBe('Untagged');
    expect(s.materials.get(s.defaultMaterialId)?.name).toBe('Default');
    expect(s.styles.get(s.activeStyleId)).toBeDefined();
    expect(s.meta.units.lengthUnit).toBe('in');
    expect(s.meta.nextId).toBe(5);
    expect(Object.isFrozen(s)).toBe(true);
  });

  it('transact yields patches, emits change, nested merges, throw discards', () => {
    const doc = createDocument();
    const events: string[] = [];
    doc.events.on('change', (e) => events.push(`${e.source}:${e.label}:${e.patches.length}`));
    const tx = doc.transact('outer', (d) => {
      const inner = doc.transact('inner', () => doc.alloc<Id>());
      expect(inner.nested).toBe(true);
      expect(inner.patches).toHaveLength(0);
      const ids = new DraftIdAllocator(d);
      const first = ids.reserve(3);
      expect(first).toBe(6);
      expect(d.meta.nextId).toBe(9);
      return inner.value;
    });
    expect(tx.value).toBe(5);
    expect(tx.patches.length).toBeGreaterThan(0);
    expect(doc.state.meta.nextId).toBe(9);
    expect(events).toEqual(['transact:outer:1']);
    expect(() =>
      doc.transact('boom', (d) => {
        d.meta.nextId = 999;
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(doc.state.meta.nextId).toBe(9);
    expect(doc.inTransaction).toBe(false);
    expect(() => doc.alloc()).toThrow();
  });

  it('undo/redo restores ids and Maps, with selection snapshots', () => {
    const doc = createDocument();
    const sel = new Selection();
    const undo = new UndoStack(doc, sel, 200);
    const before = doc.state;
    const bodyId = undo.transact(
      'add box',
      (d) => {
        const root = d.definitions.get(d.rootDefinitionId)!;
        const b = bodyFromMesh(d, meshBox([0, 0, 0], [1, 1, 1]), { container: root.entities });
        return b.id;
      },
      { commandId: 'draw.box', params: { size: 1 } },
    );
    const ref: EntityRef = { kind: 'body', path: [], id: bodyId };
    sel.add(ref);
    undo.amendLast((e) => {
      e.selectionAfter = sel.snapshot();
    });
    const after = doc.state;
    expect(doc.rootDefinition.entities.bodies.get(bodyId)).toBeDefined();
    expect(doc.rootDefinition.entities.order).toEqual([bodyId]);
    expect(undo.canUndo).toBe(true);
    expect(undo.peek()?.commandId).toBe('draw.box');

    expect(undo.undo()).toBe(true);
    // ids are never reused: the allocator stays where it was after the edit
    expect(doc.state.meta.nextId).toBe(after.meta.nextId);
    void before;
    expect(doc.rootDefinition.entities.bodies.size).toBe(0);
    expect(doc.rootDefinition.entities.order).toEqual([]);
    expect(sel.size).toBe(0);
    expect(undo.canRedo).toBe(true);

    expect(undo.redo()).toBe(true);
    expect(doc.state.meta.nextId).toBe(after.meta.nextId);
    const body = doc.rootDefinition.entities.bodies.get(bodyId)!;
    expect(body.faces.size).toBe(6);
    expect(body.edges.size).toBe(12);
    expect(sel.has(ref)).toBe(true);
    expect(undo.redo()).toBe(false);
    // untouched sub-trees keep identity after a round trip
    expect(doc.state.styles).toBe(before.styles);
  });

  it('caps the stack and ignores empty transactions', () => {
    const doc = createDocument();
    const undo = new UndoStack(doc, null, 3);
    for (let i = 0; i < 5; i++) undo.transact(`t${i}`, (d) => void (d.meta.nextId += 1));
    expect(undo.length).toBe(3);
    expect(undo.entries[0]!.label).toBe('t2');
    undo.transact('noop', () => undefined);
    expect(undo.length).toBe(3);
  });

  it('selection keys refs stably', () => {
    const sel = new Selection();
    let n = 0;
    sel.events.on('change', () => n++);
    const face: EntityRef = { kind: 'face', path: [1 as Id], id: 7 as Id, faceId: 2 as never, region: null };
    sel.add(face);
    sel.add({ ...face });
    expect(sel.size).toBe(1);
    sel.toggle(face);
    expect(sel.size).toBe(0);
    sel.toggle([face, { kind: 'edge', path: [], id: 7 as Id, edgeKey: '0:1:0' }]);
    expect(sel.size).toBe(2);
    sel.clear();
    expect(n).toBe(4);
  });
});

describe('exclusive undo groups', () => {
  const rename = (name: string) => (draft: { definitions: Map<unknown, { name: string }> }) => {
    for (const def of draft.definitions.values()) def.name = name;
  };

  it('records the owner\'s edits as one entry and refuses other edits, undo and redo meanwhile', () => {
    const doc = createDocument();
    const undo = new UndoStack(doc);
    undo.transact('before', rename('Before'));
    undo.beginGroup('AI Chat: Batch');
    undo.withinGroup(() => undo.transact('a', rename('A')));
    expect(() => undo.transact('outside', rename('Outside'))).toThrow(/being applied/);
    expect(undo.undo()).toBe(false);
    expect(() => undo.beginGroup('second')).toThrow(/still being applied/);
    undo.withinGroup(() => undo.transact('b', rename('B')));
    undo.endGroup(true);
    expect(undo.length).toBe(2);
    expect(undo.peek()!.label).toBe('AI Chat: Batch');
    expect(doc.rootDefinition.name).toBe('B');
    expect(undo.undo()).toBe(true);
    expect(doc.rootDefinition.name).toBe('Before');
    expect(undo.redo()).toBe(true);
    expect(doc.rootDefinition.name).toBe('B');
  });

  it('reverts every edit of a group that does not commit and records nothing', () => {
    const doc = createDocument();
    const sel = new Selection();
    const undo = new UndoStack(doc, sel);
    const picked: EntityRef = { kind: 'body', path: [], id: 3 as Id };
    sel.set([picked]);
    undo.beginGroup('AI Chat: Batch');
    undo.withinGroup(() => { undo.transact('a', rename('A')); sel.clear(); undo.transact('b', rename('B')); });
    undo.endGroup(false);
    expect(doc.rootDefinition.name).toBe('Model');
    expect(undo.length).toBe(0);
    expect(sel.refs).toEqual([picked]);
    expect(undo.grouped).toBe(false);
    undo.transact('after', rename('After'));
    expect(undo.length).toBe(1);
  });
});

describe('persistent ids across undo', () => {
  it('does not reuse ids after an undo', async () => {
    const { createDocument } = await import('./Document');
    const { UndoStack } = await import('./UndoStack');
    const doc = createDocument();
    const undo = new UndoStack(doc);
    const a = undo.transact('a', (draft) => allocIdFrom(draft));
    undo.undo();
    const b = undo.transact('b', (draft) => allocIdFrom(draft));
    expect(b).toBeGreaterThan(a);
  });
});
function allocIdFrom(draft: { meta: { nextId: number } }): number {
  return draft.meta.nextId++;
}
