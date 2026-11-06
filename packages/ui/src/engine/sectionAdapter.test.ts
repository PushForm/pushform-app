// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Id, Mat4 } from '@pushform/core';
import { m4translation } from '@pushform/core';
import { createDocument, sectionPlaneCorners, worldSectionPlane, type SectionPlane } from '@pushform/model';
import { sectionsToRender } from './sectionAdapter';

const plane = (id: number, z: number): SectionPlane => ({
  id: id as Id, name: `Section ${id}`, symbol: String(id), plane: { n: [0, 0, 1], d: -z }, origin: [0, 0, z],
  tagId: 0 as never, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {},
});

describe('section planes to render', () => {
  it('maps a plane through a placement and frames the content', () => {
    const { normal, d } = worldSectionPlane({ n: [0, 0, 1], d: -1 }, m4translation([0, 0, 2]) as unknown as Mat4);
    expect(normal).toEqual([0, 0, 1]);
    expect(d).toBeCloseTo(-3, 9);
    const corners = sectionPlaneCorners([0, 0, 1], -1, { min: [0, 0, 0], max: [10, 4, 2] });
    // on the plane, covering the content with a 25 % margin of its larger side
    for (const c of corners) expect(c[2]).toBeCloseTo(1, 9);
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    expect(Math.min(...xs)).toBeCloseTo(-2.5, 9);
    expect(Math.max(...xs)).toBeCloseTo(12.5, 9);
    expect(Math.min(...ys)).toBeCloseTo(-2.5, 9);
    expect(Math.max(...ys)).toBeCloseTo(6.5, 9);
  });

  it('draws every visible plane, cuts with the active one, and follows the style switches', () => {
    const doc = createDocument();
    doc.transact('sections', (draft) => {
      const root = draft.definitions.get(draft.rootDefinitionId)!.entities;
      for (const p of [plane(50, 1), { ...plane(51, 2), hidden: true }]) {
        root.sectionPlanes.set(p.id, { ...p, tagId: draft.defaultTagId } as never);
        root.order.push(p.id);
      }
      root.activeSectionPlaneId = 50 as Id;
    });
    const out = sectionsToRender(doc.state, [{ kind: 'sectionPlane', path: [], id: 50 as Id }]);
    expect(out.planes.map((p) => [p.entityId, p.active, p.selected])).toEqual([[50, true, true]]);
    expect(out.cuts).toEqual([{ key: '/50', path: [], normal: [0, 0, 1], d: -1 }]);
    doc.transact('style', (draft) => {
      const style = draft.styles.get(draft.activeStyleId)!;
      style.modeling.sectionPlanesVisible = false;
      style.modeling.sectionCutsVisible = false;
    });
    const off = sectionsToRender(doc.state);
    expect(off.planes).toEqual([]);
    expect(off.cuts).toEqual([]);
  });

  it('draws a tool\'s preview: moved planes cut where they would go, copies never cut, an added plane takes over the cut', () => {
    const doc = createDocument();
    doc.transact('sections', (draft) => {
      const root = draft.definitions.get(draft.rootDefinitionId)!.entities;
      root.sectionPlanes.set(50 as Id, { ...plane(50, 1), tagId: draft.defaultTagId } as never);
      root.order.push(50 as Id);
      root.activeSectionPlaneId = 50 as Id;
    });
    const movedTo = sectionsToRender(doc.state, [], { moved: [{ path: [], id: 50 as Id, normal: [0, 0, 1], d: -2 }], copies: [], added: null });
    expect(movedTo.cuts).toEqual([{ key: '/50', path: [], normal: [0, 0, 1], d: -2 }]);
    expect(movedTo.planes.map((p) => p.corners[0][2])).toEqual([2]);
    const copied = sectionsToRender(doc.state, [], { moved: [], copies: [{ path: [], id: 50 as Id, normal: [0, 0, 1], d: -2 }], added: null });
    expect(copied.cuts).toEqual([{ key: '/50', path: [], normal: [0, 0, 1], d: -1 }]);
    expect(copied.planes.map((p) => [p.entityId, p.active])).toEqual([[50, true], [50, false]]);
    const adding = sectionsToRender(doc.state, [], { moved: [], copies: [], added: { path: [], normal: [0, 0, 1], d: -3 } });
    expect(adding.cuts).toEqual([{ key: '/-1', path: [], normal: [0, 0, 1], d: -3 }]);
    expect(adding.planes.map((p) => [p.entityId, p.active])).toEqual([[50, false], [-1, true]]);
    // the document's own sections are unchanged
    expect(sectionsToRender(doc.state).cuts).toEqual([{ key: '/50', path: [], normal: [0, 0, 1], d: -1 }]);
  });

  it('draws hidden planes, marked hidden, only while hidden geometry is shown', () => {
    const doc = createDocument();
    doc.transact('sections', (draft) => {
      const root = draft.definitions.get(draft.rootDefinitionId)!.entities;
      const p = { ...plane(51, 2), hidden: true };
      root.sectionPlanes.set(p.id, { ...p, tagId: draft.defaultTagId } as never);
      root.order.push(p.id);
    });
    expect(sectionsToRender(doc.state).planes).toEqual([]);
    doc.transact('style', (draft) => { draft.styles.get(draft.activeStyleId)!.modeling.hiddenGeometry = true; });
    expect(sectionsToRender(doc.state).planes.map((p) => [p.entityId, p.hidden])).toEqual([[51, true]]);
  });
});
