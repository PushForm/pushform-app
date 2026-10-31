// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Id, TagId } from '@pushform/core';
import { allocId } from '@pushform/model';
import type { EntityRef, MeshPart } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { DocumentHost } from '../host/DocumentHost';
import { MemoryDisplayHost } from '../host/DisplayHost';
import { SERVICE_DISPLAY, SERVICE_DOCUMENT } from '../host/services';
import { contextCommands } from './context';
import { contextMenu } from './contextMenu';
import { groupCommands } from './groups';
import { materialCommands } from './materials';
import type { PaintResult } from './materials';
import { modelCommands } from './model';
import { captureSceneProps } from './scenes';
import { sketchCommands } from './sketch';
import { tagCommands, tagUsage } from './tags';

/** One triangle with two source faces, the second carrying its own material id. */
function addMeshPart(host: DocumentHost): Id {
  let id = 0 as Id;
  host.doc.transact('mesh part', (draft) => {
    const root = draft.definitions.get(draft.rootDefinitionId)!.entities;
    id = allocId<Id>(draft);
    const part: MeshPart = {
      id,
      name: 'Bracket',
      source: { format: 'STEP', system: '' },
      tagId: draft.defaultTagId,
      hidden: false,
      locked: false,
      castShadows: true,
      receiveShadows: true,
      attributes: {},
      materialId: null,
      geometry: {
        positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        triangles: new Uint32Array([0, 1, 2]),
        triangleFace: new Uint32Array([0]),
        faceCount: 2,
        faceMaterials: new Uint32Array([0, 42]),
        edgeOffsets: new Uint32Array([]),
        edgePositions: new Float64Array([]),
        edgeFlags: new Uint8Array([]),
      },
    };
    root.meshParts.set(id, part as never);
    root.order.push(id);
  });
  return id;
}

function setup() {
  const host = new DocumentHost();
  const registry = new CommandRegistry({
    tx: host,
    services: new Map<string, unknown>([
      [SERVICE_DOCUMENT, host],
      [SERVICE_DISPLAY, new MemoryDisplayHost()],
    ]),
  });
  registry.registerAll(editCommands);
  registry.registerAll(modelCommands);
  registry.registerAll(sketchCommands);
  registry.registerAll(groupCommands);
  registry.registerAll(contextCommands);
  registry.registerAll(materialCommands);
  registry.registerAll(tagCommands);
  const id = addMeshPart(host);
  const ref: EntityRef = { kind: 'meshPart', path: [], id };
  const root = () => host.doc.rootDefinition.entities;
  const part = () => root().meshParts.get(id)!;
  return { host, registry, id, ref, root, part };
}

describe('mesh parts behave like bodies', () => {
  it('takes a tag, counts in tag usage, and Select All With Tag finds it', () => {
    const { registry, host, ref, part } = setup();
    const tag = registry.execute('tag.create', { name: 'Hardware' }) as number;
    expect(registry.execute('tag.assign', { refs: [ref], tagId: tag })).toBe(1);
    expect(part().tagId).toBe(tag);
    expect(tagUsage(host.doc.state).get(tag as TagId)).toBe(1);
    expect(registry.execute('tag.selectAll', { id: tag })).toBe(1);
    expect(host.selection.refs).toEqual([ref]);
    // deleting the tag with its contents erases the part
    registry.execute('tag.delete', { id: tag, contents: 'delete' });
    expect(host.doc.rootDefinition.entities.meshParts.size).toBe(0);
  });

  it('hides and unhides with bodies.setHidden, leaving the selection and the scene capture when hidden', () => {
    const { registry, host, ref, id, part } = setup();
    host.selection.set([ref]);
    expect(registry.execute('bodies.setHidden', { refs: [ref], hidden: true })).toBe(1);
    expect(part().hidden).toBe(true);
    expect(host.selection.isEmpty).toBe(true);
    expect(captureSceneProps(host.doc.state, null).hiddenEntities).toContain(id);
    expect(registry.execute('bodies.setHidden', { refs: [ref], hidden: false })).toBe(1);
    expect(part().hidden).toBe(false);
    host.undo();
    expect(part().hidden).toBe(true);
  });

  it('erases with edit.delete: gone from the map and from the order', () => {
    const { registry, host, ref, id, root } = setup();
    expect(root().order).toContain(id);
    host.selection.set([ref]);
    const result = registry.execute('edit.delete', {}) as { removed: number; skipped: number };
    expect(result).toMatchObject({ removed: 1, skipped: 0 });
    expect(root().meshParts.has(id)).toBe(false);
    expect(root().order).not.toContain(id);
    host.undo();
    expect(root().meshParts.has(id)).toBe(true);
    expect(root().order).toContain(id);
  });

  it('paints the whole part and leaves the per-face materials alone; the sample reads the part material', () => {
    const { registry, ref, part } = setup();
    const red = registry.execute('material.create', { name: 'Red', color: [1, 0, 0] }) as number;
    const geometry = part().geometry;
    const result = registry.execute('paint.apply', { refs: [ref], materialId: red }) as PaintResult;
    expect(result.painted).toBe(1);
    expect(part().materialId).toBe(red);
    expect(part().geometry).toBe(geometry);
    expect([...part().geometry.faceMaterials]).toEqual([0, 42]);
    expect(registry.execute('paint.sample', { ref })).toBe(red);
  });

  it('turns shadows on and off with entity.setShadows', () => {
    const { registry, ref, part } = setup();
    expect(registry.execute('entity.setShadows', { refs: [ref], cast: false })).toBe(1);
    expect(part().castShadows).toBe(false);
    expect(part().receiveShadows).toBe(true);
    registry.execute('entity.setShadows', { refs: [ref], receive: false });
    expect(part().receiveShadows).toBe(false);
  });

  it('Select All includes mesh parts', () => {
    const { registry, host, ref } = setup();
    registry.execute('edit.selectAll', {});
    expect(host.selection.has(ref)).toBe(true);
  });

  it('context menu: Entity Info, Erase, Hide/Unhide, Make Group, Make Component…, Zoom Selection', () => {
    const { registry, host, ref } = setup();
    const items = contextMenu.itemsFor(host.doc.state, [ref]);
    expect(items.map((i) => i.label)).toEqual(['Entity Info', 'Erase', 'Hide', 'Make Group', 'Make Component…', 'Zoom Selection']);
    expect(items[2]).toMatchObject({ command: 'bodies.setHidden', params: { refs: [ref], hidden: true } });
    expect(items[3]).toMatchObject({ command: 'group.make', params: { refs: [ref] } });
    registry.execute('bodies.setHidden', { refs: [ref], hidden: true });
    expect(contextMenu.itemsFor(host.doc.state, [ref])[2]).toMatchObject({ label: 'Unhide', params: { hidden: false } });
    // mixed with a body: the shared items only
    const mixed = contextMenu.itemsFor(host.doc.state, [ref, { kind: 'body', path: [], id: 7 as Id }]);
    expect(mixed.map((i) => i.label)).toEqual(['Entity Info', 'Erase', 'Make Group', 'Make Component…', 'Zoom Selection']);
  });
});
