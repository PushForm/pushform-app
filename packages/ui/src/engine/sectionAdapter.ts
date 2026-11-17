// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, Mat4 } from '@pushform/core';
import { M4_IDENTITY } from '@pushform/core';
import type { SectionPreview } from '@pushform/commands';
import { containerAt, contentWorldBounds, contextMatrix, pathKey, sectionPlaneCorners, tagVisible, worldSectionPlane } from '@pushform/model';
import type { DocumentState, EntityContainer, EntityRef } from '@pushform/model';
import { EMPTY_SECTIONS, renderKey } from '@pushform/render';
import type { RenderSectionCut, RenderSectionPlane, RenderSections } from '@pushform/render';
import { rgbToCss } from './format';
import { instancesToRender } from './renderAdapter';

let cache: { state: DocumentState; selection: readonly EntityRef[]; out: RenderSections } | null = null;

/** The last result for a tool's preview, so an unchanged preview is not drawn again. */
let previewCache: { state: DocumentState; selection: readonly EntityRef[]; preview: SectionPreview; out: RenderSections } | null = null;

/** Key of a plane being added by a tool, which has no entity id yet. */
const ADDED_ID = -1;

/**
 * Section planes and active cuts of the model and of every visible group and component, in world
 * coordinates, with the active style's display switches and colors. Reused while the state and selection are.
 * `preview` shows planes a tool is dragging where they would be, and cutting as they would, without changing the document.
 */
export function sectionsToRender(state: DocumentState, selection: readonly EntityRef[] = [], preview: SectionPreview | null = null): RenderSections {
  const hit = preview ? previewCache : cache;
  if (hit && hit.state === state && hit.selection === selection && (!preview || previewCache?.preview === preview)) return hit.out;
  const root = state.definitions.get(state.rootDefinitionId);
  const style = state.styles.get(state.activeStyleId)?.modeling;
  if (!root || !style) return EMPTY_SECTIONS;
  const selected = new Set(selection.filter((r) => r.kind === 'sectionPlane').map((r) => `${pathKey(r.path)}/${r.id}`));
  const sources: [readonly Id[], EntityContainer, Mat4][] = [[[], root.entities, M4_IDENTITY]];
  for (const inst of instancesToRender(state)) if (inst.definition.entities.sectionPlanes.size) sources.push([inst.path, inst.definition.entities, inst.matrix]);
  const added = preview?.added ?? null;
  // a plane about to be added may go into a container that has none yet
  if (added && !sources.some(([path]) => pathKey(path) === pathKey(added.path))) {
    try {
      sources.push([added.path, containerAt(state, added.path), contextMatrix(state, added.path) as unknown as Mat4]);
    } catch {
      // the container is gone; nothing to preview
    }
  }
  const moved = new Map((preview?.moved ?? []).map((m) => [`${pathKey(m.path)}/${m.id}`, m]));
  const planes: RenderSectionPlane[] = [], cuts: RenderSectionCut[] = [];
  for (const [path, container, matrix] of sources) {
    const adding = added !== null && pathKey(added.path) === pathKey(path);
    if (!container.sectionPlanes.size && !adding) continue;
    const bounds = contentWorldBounds(state, path);
    for (const sp of container.sectionPlanes.values()) {
      const { normal, d } = moved.get(`${pathKey(path)}/${sp.id}`) ?? worldSectionPlane(sp.plane, matrix);
      const key = renderKey(path, sp.id);
      // the plane being added takes over its container's cut
      const active = container.activeSectionPlaneId === sp.id && !adding;
      if (active && style.sectionCutsVisible) cuts.push({ key, path, normal, d });
      // hidden planes are drawn, as an outline, only while hidden geometry is shown
      if (!style.sectionPlanesVisible || (sp.hidden && !style.hiddenGeometry) || !tagVisible(state, sp.tagId)) continue;
      planes.push({ id: key, path, entityId: sp.id, corners: sectionPlaneCorners(normal, d, bounds), normal, symbol: sp.symbol, active,
        selected: selected.has(`${pathKey(path)}/${sp.id}`), ...(sp.hidden ? { hidden: true } : {}) });
    }
    if (adding) {
      const key = renderKey(path, ADDED_ID);
      if (style.sectionCutsVisible) cuts.push({ key, path, normal: added.normal, d: added.d });
      if (style.sectionPlanesVisible) {
        planes.push({ id: key, path, entityId: ADDED_ID, corners: sectionPlaneCorners(added.normal, added.d, bounds), normal: added.normal, symbol: '', active: true, selected: true });
      }
    }
  }
  // copies are drawn where they would go, never cutting
  if (style.sectionPlanesVisible) {
    for (const [i, c] of (preview?.copies ?? []).entries()) {
      let source;
      try {
        source = containerAt(state, c.path).sectionPlanes.get(c.id);
      } catch {
        source = undefined;
      }
      if (!source) continue;
      planes.push({ id: `${renderKey(c.path, c.id)}+${i}`, path: c.path, entityId: c.id, corners: sectionPlaneCorners(c.normal, c.d, contentWorldBounds(state, c.path)),
        normal: c.normal, symbol: source.symbol, active: false, selected: true });
    }
  }
  const out: RenderSections = {
    planes, cuts, fill: style.sectionFillEnabled,
    activeColor: rgbToCss(style.activeSection), inactiveColor: rgbToCss(style.inactiveSection),
    fillColor: rgbToCss(style.sectionFill), lineColor: rgbToCss(style.sectionLine), lineWidth: style.sectionLineWidth,
  };
  if (preview) previewCache = { state, selection, preview, out };
  else cache = { state, selection, out };
  return out;
}
