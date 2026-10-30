// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { M4_IDENTITY, newGuid, type DefId, type Id } from '@pushform/core';
import { createDocument, createEntityContainer, type ComponentDefinition } from '@pushform/model';
import type { LayoutEntity } from './LayoutDocument';
import type { LayoutModelAttachment } from './modelAttachments';
import { layoutModelLabelFields } from './modelLabelFields';

it('resolves enclosing component attributes without substituting document fields or unavailable attributes', () => {
  const model = createDocument(), instanceId = 100 as Id, definitionId = 101 as DefId;
  model.transact('Component', state => {
    const definitions = state.definitions as unknown as Map<DefId, ComponentDefinition>;
    const root = definitions.get(state.rootDefinitionId)!;
    definitions.set(definitionId, { ...root, id: definitionId, guid: newGuid(), name: 'Window', description: 'Double glazed',
      isGroup: false, entities: createEntityContainer() });
    root.entities.instances.set(instanceId, { id: instanceId, definitionId, transform: M4_IDENTITY, name: 'North window',
      materialId: null, hidden: false, locked: false, tagId: state.defaultTagId, castShadows: true, receiveShadows: true,
      attributes: { dynamic_attributes: { WindowType: 'Casement', Count: 2, Openable: false, _formula: 'ignored', Complex: { nested: true } } } });
  });
  const attachment: LayoutModelAttachment = { viewportId: 1, source: { referenceId: 2 }, modelGuid: model.state.meta.guid,
    anchor: { kind: 'sketchVertex', path: [instanceId], id: 102 as Id } };
  const view = { image: { viewport: { scene: 'Elevation', camera: { projection: 'parallel', scale: 0.01 } } } } as LayoutEntity;
  const fields = () => layoutModelLabelFields(attachment, view, model.state, [1, 2, 3]);
  expect(fields()).toMatchObject({ SceneName: 'Elevation', Ratio: '1:100', ComponentInstance: 'North window',
    ComponentDefinition: 'Window', ComponentDescription: 'Double glazed', WindowType: 'Casement',
    'DynamicComponent(WindowType)': 'Casement', Count: '2', Openable: 'false' });
  expect(fields()).not.toHaveProperty('_formula');
  expect(fields()).not.toHaveProperty('Complex');
  expect(fields()).not.toHaveProperty('GroupName');
  model.transact('Rename', state => {
    state.definitions.get(state.rootDefinitionId)!.entities.instances.get(instanceId)!.name = 'East window';
    state.definitions.get(definitionId)!.isGroup = true;
  });
  expect(fields()).toMatchObject({ ComponentInstance: 'East window', GroupName: 'East window' });
  view.image!.viewport!.camera.projection = 'perspective';
  expect(fields()).not.toHaveProperty('Ratio');
});
