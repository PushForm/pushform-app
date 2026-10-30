// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { DEFAULT_UNITS, m4identity } from '@pushform/core';
import type { DefId, Id, ImageId, Mat4, StyleId, TagId } from '@pushform/core';
import { allocId, createEntityContainer, createMaterial } from '@pushform/model';
import type { DocumentDraft, DocumentState } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { DocumentHost } from '../host/DocumentHost';
import { activeMaterialOf, displayOf, SERVICE_DOCUMENT } from '../host/services';
import { modelInfoCommands } from './modelInfo';
import { styleCommands } from './styles';
import { tagCommands } from './tags';

function setup() {
  const host = new DocumentHost();
  const registry = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host]]) });
  for (const list of [editCommands, modelInfoCommands, styleCommands, tagCommands]) registry.registerAll(list);
  return { host, registry, state: () => host.doc.state };
}
const draftState = (draft: DocumentDraft): DocumentState => draft as unknown as DocumentState;

describe('model.setUnits', () => {
  it('changes the units in one undoable step and keeps the length unit of fixed-unit formats', () => {
    const { host, registry, state } = setup();
    expect(state().meta.units).toEqual(DEFAULT_UNITS);
    registry.execute('model.setUnits', { patch: { format: 'decimal', lengthUnit: 'mm', lengthPrecision: 1, areaUnit: 'm²', lengthSnap: 0.005, angleSnap: null } });
    expect(state().meta.units).toMatchObject({ format: 'decimal', lengthUnit: 'mm', lengthPrecision: 1, areaUnit: 'm²', lengthSnap: 0.005, angleSnap: null });
    host.undo();
    expect(state().meta.units).toEqual(DEFAULT_UNITS);
    host.redo();
    registry.execute('model.setUnits', { patch: { format: 'engineering' } });
    expect(state().meta.units.lengthUnit).toBe('ft');
    registry.execute('model.setUnits', { patch: { format: 'fractional', lengthUnit: 'm' } });
    expect(state().meta.units.lengthUnit).toBe('in');
    expect(() => registry.execute('model.setUnits', { patch: { lengthPrecision: 7 } })).toThrow(/Invalid params/);
    expect(() => registry.execute('model.setUnits', { patch: { anglePrecision: 4 } })).toThrow(/Invalid params/);
  });

  it('adds no undo step when nothing changes', () => {
    const { host, registry } = setup();
    registry.execute('model.setUnits', { patch: { format: 'architectural', lengthUnit: 'in' } });
    expect(host.canUndo()).toBe(false);
  });
});

describe('model.purgeUnused', () => {
  it('removes unplaced definitions, then the styles, tags, materials and images nothing uses, in one undo step', () => {
    const { host, registry, state } = setup();
    let usedMaterial = 0, purgedMaterial = 0, keptTag = 0, purgedTag = 0, sceneStyle = 0;
    host.edit('fixture', (draft) => {
      const s = draftState(draft);
      const image = (sha: string): ImageId => {
        const id = allocId<ImageId>(draft);
        s.images.set(id, { id, name: sha, mime: 'image/png', width: 1, height: 1, sha256: sha });
        return id;
      };
      usedMaterial = createMaterial(draft, { name: 'Used', color: [1, 0, 0] }).id;
      purgedMaterial = createMaterial(draft, { name: 'Only unplaced', color: [0, 1, 0], texture: { imageId: image('a'), widthM: 1, heightM: 1, colorize: false } }).id;
      image('b'); // referenced by nothing
      keptTag = allocId<TagId>(draft);
      purgedTag = allocId<TagId>(draft);
      for (const id of [keptTag, purgedTag]) s.tags.set(id as TagId, { ...s.tags.get(s.defaultTagId)!, id: id as TagId, name: `Tag ${id}` });
      const root = s.definitions.get(s.rootDefinitionId)!;
      const define = (name: string, isGroup: boolean): DefId => {
        const id = allocId<DefId>(draft);
        s.definitions.set(id, { ...root, id, name, isGroup, entities: createEntityContainer(), bounds: null });
        return id;
      };
      const place = (into: DefId, def: DefId, materialId: number | null, tagId: TagId): void => {
        const id = allocId<Id>(draft);
        s.definitions.get(into)!.entities.instances.set(id, { id, definitionId: def, transform: m4identity() as unknown as Mat4, name: '',
          materialId: materialId as never, tagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} } as never);
      };
      const placed = define('Placed', false), inner = define('Inner', false), unplaced = define('Unplaced', false), deep = define('Only inside unplaced', true);
      place(s.rootDefinitionId, placed, usedMaterial, keptTag as TagId);
      place(placed, inner, null, s.defaultTagId);
      place(unplaced, deep, purgedMaterial, purgedTag as TagId);
      const base = s.styles.get(s.activeStyleId)!;
      for (const name of ['Scene style', 'Unused style']) {
        const id = allocId<StyleId>(draft);
        s.styles.set(id, { ...base, id, name });
        if (name === 'Scene style') sceneStyle = id;
      }
    });
    // A scene keeps its style.
    host.edit('scene', (draft) => {
      const s = draftState(draft);
      const id = allocId<number>(draft) as never;
      s.scenes.set(id, { id, name: 'Scene', styleId: sceneStyle as StyleId, hiddenTags: [] } as never);
      s.sceneOrder.push(id);
    });
    activeMaterialOf(registry.ctx).set(purgedMaterial);
    displayOf(registry.ctx).set({ activeTagId: purgedTag });
    const before = { definitions: state().definitions.size, styles: state().styles.size, tags: state().tags.size, materials: state().materials.size, images: state().images.size };

    expect(registry.execute('model.purgeUnused', {})).toEqual({ definitions: 2, styles: 1, tags: 1, materials: 1, images: 2 });
    expect([...state().definitions.values()].map((d) => d.name).sort()).toEqual(['Inner', 'Placed', state().definitions.get(state().rootDefinitionId)!.name].sort());
    expect(state().styles.has(sceneStyle as StyleId)).toBe(true);
    expect(state().tags.has(keptTag as TagId)).toBe(true);
    expect(state().materials.has(usedMaterial as never)).toBe(true);
    expect(state().images.size).toBe(0);
    expect(activeMaterialOf(registry.ctx).get()).toBeNull();
    expect(displayOf(registry.ctx).get().activeTagId).toBeNull();

    host.undo();
    expect({ definitions: state().definitions.size, styles: state().styles.size, tags: state().tags.size, materials: state().materials.size, images: state().images.size }).toEqual(before);
    host.redo();
    // Nothing left to purge: no change and no undo step.
    const undoDepth = () => { let n = 0; while (host.canUndo()) { host.undo(); n++; } for (let i = 0; i < n; i++) host.redo(); return n; };
    const depth = undoDepth();
    expect(registry.execute('model.purgeUnused', {})).toEqual({ definitions: 0, styles: 0, tags: 0, materials: 0, images: 0 });
    expect(undoDepth()).toBe(depth);
  });
});
