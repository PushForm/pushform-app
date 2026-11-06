// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { DefId, Guid, Id, SceneId, StyleId } from '@pushform/core';
import { allocId, createDefaultStyle, createDocument, createEntityContainer, DEFAULT_AXES, DEFAULT_BEHAVIORS, DEFAULT_SCENE_FLAGS, ImageStore,
  type ComponentDefinition, type DocumentState, type Draft, type EntityContainer, type Scene, type SceneFlags, type Style } from '@pushform/model';
import { sectionsToRender } from '../engine/sectionAdapter';
import { viewSectionState, type LayoutViewportModel } from './layoutViewportRenders';

/**
 * A model with a section plane in the model (`Plan`, at z = 1) and one in a group definition (`Inner`), where the model
 * currently cuts with neither but the group's plane, and these scenes:
 * - `Cut`: keeps `Plan` active and the group's cut off, with a style that hides section planes and fills cuts red;
 * - `Open`: saves its section planes with none active;
 * - `Keeps`: does not save section planes, and saves no style.
 */
function fixture(): { model: LayoutViewportModel; plan: Id; inner: Id; group: DefId; style: StyleId } {
  const doc = createDocument();
  const ids = doc.transact('Fixture', draft => {
    const plane = (container: Draft<EntityContainer>, name: string, z: number): Id => {
      const id = allocId<Id>(draft);
      container.sectionPlanes.set(id, { id, name, symbol: name[0]!, plane: { n: [0, 0, -1], d: z }, origin: [0, 0, z],
        tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} });
      container.order.push(id);
      return id;
    };
    const root = draft.definitions.get(draft.rootDefinitionId)!.entities;
    const plan = plane(root, 'Plan', 1);
    const group = allocId<DefId>(draft), entities = createEntityContainer() as unknown as Draft<EntityContainer>;
    const inner = plane(entities, 'Inner', 0.5);
    entities.activeSectionPlaneId = inner;
    draft.definitions.set(group, { id: group, guid: 'group' as Guid, name: 'Group', description: '', isGroup: true, axes: DEFAULT_AXES,
      behaviors: DEFAULT_BEHAVIORS, entities, bounds: null } as Draft<ComponentDefinition>);
    const style = allocId<StyleId>(draft), cutStyle = createDefaultStyle(style);
    cutStyle.name = 'Cut style';
    Object.assign(cutStyle.modeling, { sectionPlanesVisible: false, sectionCutsVisible: true, sectionFillEnabled: true, sectionFill: [1, 0, 0],
      sectionLineWidth: 7, guidesVisible: false });
    draft.styles.set(style, cutStyle as Draft<Style>);
    const scene = (name: string, flags: Partial<SceneFlags>, activeSectionPlanes: Id[], styleId: StyleId | null) => {
      const id = allocId<SceneId>(draft);
      const saved: Scene = { id, name, description: '', camera: { eye: [5, 5, 5], target: [0, 0, 0], up: [0, 0, 1], perspective: true, fov: 35, height: 1 },
        flags: { ...DEFAULT_SCENE_FLAGS, useTags: false, ...flags }, hiddenEntities: [], hiddenTags: [], hiddenTagFolders: [], styleId, shadows: null,
        activeSectionPlanes, axesVisible: true };
      draft.scenes.set(id, saved as Draft<Scene>); draft.sceneOrder.push(id);
    };
    scene('Cut', {}, [plan], style);
    scene('Open', { useStyle: false }, [], null);
    scene('Keeps', { useStyle: false, useSectionPlanes: false }, [], null);
    return { plan, inner, group, style };
  }).value;
  const model = { state: doc.state, scenes: [], images: new ImageStore(), bounds: null, bodies: [], sketches: [], pictures: [],
    display: {} as LayoutViewportModel['display'] } satisfies LayoutViewportModel;
  return { model, ...ids };
}

const active = (state: DocumentState, def: DefId) => state.definitions.get(def)!.entities.activeSectionPlaneId;

describe('Section cuts of Layout model views', () => {
  it("cuts a view with the active section planes its scene saved, turning off the other containers' cuts", () => {
    const { model, plan, group } = fixture();
    const state = viewSectionState(model, 'Cut');
    expect(active(state, state.rootDefinitionId)).toBe(plan);
    expect(active(state, group)).toBeNull();
    const sections = sectionsToRender(state);
    expect(sections.cuts.map(cut => [cut.normal, cut.d])).toEqual([[[0, 0, -1], 1]]);
    // The model itself is not changed, and the view is reused while the model is the same.
    expect(active(model.state, model.state.rootDefinitionId)).toBeNull();
    expect(viewSectionState(model, 'Cut')).toBe(state);
  });

  it('shows no cut in a view of a scene that saved none, and the model\'s cuts for one that does not save them or no scene', () => {
    const { model, inner, group } = fixture();
    const open = viewSectionState(model, 'Open');
    expect(active(open, open.rootDefinitionId)).toBeNull();
    expect(active(open, group)).toBeNull();
    for (const scene of ['Keeps', null, 'Missing']) {
      const state = viewSectionState(model, scene);
      expect(active(state, group)).toBe(inner);
      expect(state.styles).toBe(model.state.styles);
    }
  });

  it("draws section planes and cuts with the section settings of the scene's saved style, leaving its other settings", () => {
    const { model } = fixture();
    const own = sectionsToRender(model.state);
    expect(own.planes.map(plane => plane.symbol)).toEqual(['P']);
    const state = viewSectionState(model, 'Cut'), sections = sectionsToRender(state);
    expect(sections.planes).toEqual([]);
    expect(sections).toMatchObject({ fill: true, fillColor: '#ff0000', lineWidth: 7 });
    const modeling = state.styles.get(state.activeStyleId)!.modeling, before = model.state.styles.get(model.state.activeStyleId)!.modeling;
    expect(state.activeStyleId).toBe(model.state.activeStyleId);
    expect(modeling.guidesVisible).toBe(before.guidesVisible);
    expect(sectionsToRender(viewSectionState(model, 'Open')).planes.map(plane => plane.symbol)).toEqual(['P']);
  });

  it("lets a view's own section display settings replace its scene's", () => {
    const { model, plan } = fixture();
    const sections = { planes: true, cuts: false, fill: false, lineWidth: 2, lineColor: [0, 0, 1] as [number, number, number] };
    const state = viewSectionState(model, 'Cut', sections);
    // The scene still chooses the cut; the view decides how it is drawn.
    expect(active(state, state.rootDefinitionId)).toBe(plan);
    expect(sectionsToRender(state)).toMatchObject({ cuts: [], fill: false, lineWidth: 2, lineColor: '#0000ff', fillColor: '#ff0000' });
    expect(sectionsToRender(state).planes.map(plane => plane.symbol)).toEqual(['P']);
    expect(viewSectionState(model, 'Cut', { ...sections })).toBe(state);
    expect(sectionsToRender(viewSectionState(model, null, { planes: false, cuts: true })).planes).toEqual([]);
  });
});
