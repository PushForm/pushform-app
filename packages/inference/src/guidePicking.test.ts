// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { m4translation, meshBox, type DefId, type Id, type TagId } from '@pushform/core';
import { bodyFromMesh, createDocument, createEntityContainer } from '@pushform/model';
import { InferenceEngineImpl } from './InferenceEngineImpl';
import type { InferenceInput } from './types';

const input = (x = 0, y = 0): InferenceInput => ({ ray: { origin: [x, y, 10], dir: [0, 0, -1] }, screen: [x * 100, y * 100], pixelSizeAt: () => 0.01 });
function fixture() {
  const doc = createDocument();
  let guide = 0 as Id, tag = 0 as TagId;
  doc.transact('guide', d => {
    guide = d.meta.nextId++ as Id;
    tag = d.meta.nextId++ as TagId;
    d.tags.set(tag, { id: tag, name: 'Guides', color: [1, 0, 0], visible: true, folderId: null, dashes: null });
    d.definitions.get(d.rootDefinitionId)!.entities.guides.set(guide, { id: guide, kind: 'line', origin: [0, 0, 0], dir: [1, 0, 0], tagId: tag, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} });
  });
  const engine = new InferenceEngineImpl();
  const pick = () => { engine.setState(doc.state); return engine.pick(input()); };
  return { doc, engine, guide, tag, pick };
}

describe('guide picking', () => {
  it('honors guide, tag and display visibility, including showing guides again', () => {
    const { doc, guide, tag, pick } = fixture();
    expect(pick()?.ref).toEqual({ kind: 'guide', path: [], id: guide });
    doc.transact('hide', d => { d.definitions.get(d.rootDefinitionId)!.entities.guides.get(guide)!.hidden = true; });
    expect(pick()).toBeNull();
    doc.transact('hide tag', d => { d.definitions.get(d.rootDefinitionId)!.entities.guides.get(guide)!.hidden = false; d.tags.get(tag)!.visible = false; });
    expect(pick()).toBeNull();
    doc.transact('hide display', d => { d.tags.get(tag)!.visible = true; d.styles.get(d.activeStyleId)!.modeling.guidesVisible = false; });
    expect(pick()).toBeNull();
    doc.transact('show', d => { d.styles.get(d.activeStyleId)!.modeling.guidesVisible = true; });
    expect(pick()?.ref.id).toBe(guide);
  });

  it('picks a guide on a face without replacing drawing surface hits, and rejects occluded guides', () => {
    const { doc, engine, guide, pick } = fixture();
    doc.transact('box', d => { bodyFromMesh(d, meshBox([-1, -1, -1], [1, 1, 0]), { container: d.definitions.get(d.rootDefinitionId)!.entities }); });
    expect(pick()?.ref.id).toBe(guide);
    expect(engine.resolve(input(), { pickOnly: true }).hit?.ref.kind).toBe('guide');
    expect(engine.resolve(input()).hit?.ref.kind).toBe('face');
    expect(engine.pick(input(1, 0))?.ref.kind).toBe('edge');
    doc.transact('occlude', d => { bodyFromMesh(d, meshBox([-1, -1, 1], [1, 1, 2]), { container: d.definitions.get(d.rootDefinitionId)!.entities }); });
    expect(pick()?.ref.kind).toBe('face');
  });

  it('selects the containing placement until its edit context is opened', () => {
    const { doc, engine, guide } = fixture();
    let instance = 0 as Id;
    doc.transact('nest', d => {
      const root = d.definitions.get(d.rootDefinitionId)!;
      const def = d.meta.nextId++ as DefId;
      const entities = createEntityContainer();
      entities.guides.set(guide, root.entities.guides.get(guide)! as never);
      root.entities.guides.clear();
      d.definitions.set(def, { ...root, id: def, name: 'Guides', entities } as never);
      instance = d.meta.nextId++ as Id;
      root.entities.instances.set(instance, { id: instance, definitionId: def, name: '', transform: m4translation([0, 2, 0]), tagId: d.defaultTagId, materialId: null, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} } as never);
    });
    engine.setState(doc.state);
    expect(engine.pick(input(0, 2))?.selectable).toEqual({ kind: 'instance', path: [], id: instance });
    expect(engine.pick(input(0, 2), { context: [instance] })?.selectable).toEqual({ kind: 'guide', path: [instance], id: guide });
  });
});
