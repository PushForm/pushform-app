// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, Mat4 } from '@pushform/core';
import { M4_IDENTITY } from '@pushform/core';
import { contentWorldBounds, pathKey, sectionPlaneCorners, tagVisible, worldSectionPlane } from '@pushform/model';
import type { DocumentState, EntityContainer, EntityRef } from '@pushform/model';
import { EMPTY_SECTIONS, renderKey } from '@pushform/render';
import type { RenderSectionCut, RenderSectionPlane, RenderSections } from '@pushform/render';
import { rgbToCss } from './format';
import { instancesToRender } from './renderAdapter';

let cache: { state: DocumentState; selection: readonly EntityRef[]; out: RenderSections } | null = null;

/**
 * Section planes and active cuts of the model and of every visible group and component, in world
 * coordinates, with the active style's display switches and colors. Reused while the state and selection are.
 */
export function sectionsToRender(state: DocumentState, selection: readonly EntityRef[] = []): RenderSections {
  if (cache && cache.state === state && cache.selection === selection) return cache.out;
  const root = state.definitions.get(state.rootDefinitionId);
  const style = state.styles.get(state.activeStyleId)?.modeling;
  if (!root || !style) return EMPTY_SECTIONS;
  const selected = new Set(selection.filter((r) => r.kind === 'sectionPlane').map((r) => `${pathKey(r.path)}/${r.id}`));
  const sources: [readonly Id[], EntityContainer, Mat4][] = [[[], root.entities, M4_IDENTITY]];
  for (const inst of instancesToRender(state)) if (inst.definition.entities.sectionPlanes.size) sources.push([inst.path, inst.definition.entities, inst.matrix]);
  const planes: RenderSectionPlane[] = [], cuts: RenderSectionCut[] = [];
  for (const [path, container, matrix] of sources) {
    if (!container.sectionPlanes.size) continue;
    const bounds = contentWorldBounds(state, path);
    for (const sp of container.sectionPlanes.values()) {
      const { normal, d } = worldSectionPlane(sp.plane, matrix);
      const key = renderKey(path, sp.id);
      const active = container.activeSectionPlaneId === sp.id;
      if (active && style.sectionCutsVisible) cuts.push({ key, path, normal, d });
      if (!style.sectionPlanesVisible || sp.hidden || !tagVisible(state, sp.tagId)) continue;
      planes.push({ id: key, path, entityId: sp.id, corners: sectionPlaneCorners(normal, d, bounds), normal, symbol: sp.symbol, active,
        selected: selected.has(`${pathKey(path)}/${sp.id}`) });
    }
  }
  const out: RenderSections = {
    planes, cuts, fill: style.sectionFillEnabled,
    activeColor: rgbToCss(style.activeSection), inactiveColor: rgbToCss(style.inactiveSection),
    fillColor: rgbToCss(style.sectionFill), lineColor: rgbToCss(style.sectionLine), lineWidth: style.sectionLineWidth,
  };
  cache = { state, selection, out };
  return out;
}
