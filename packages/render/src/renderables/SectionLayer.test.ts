// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { M4_IDENTITY, meshBox } from '@pushform/core';
import { BufferGeometry } from 'three';
import type { RenderBody, RenderSections } from '../types';
import { EMPTY_SECTIONS } from '../types';
import { SectionLayer } from './SectionLayer';
import { clipPlaneOf, sectionSegments } from './sectionGeometry';

const box = meshBox([0, 0, 0], [2, 2, 2]);
const body = (path: number[] = []): RenderBody => ({ id: `${path.join('.')}/1`, path, entityId: 1, mesh: box, transform: M4_IDENTITY });

describe('sectionSegments', () => {
  it('outlines where a plane crosses a box', () => {
    // z = 1 crosses the four sides of a 2 m box.
    const seg = sectionSegments(box, M4_IDENTITY, [0, 0, 1], -1, [0, 0, 0]);
    expect(seg.length % 6).toBe(0);
    let length = 0;
    for (let i = 0; i < seg.length; i += 6) {
      expect(seg[i + 2]).toBeCloseTo(1, 9);
      expect(seg[i + 5]).toBeCloseTo(1, 9);
      length += Math.hypot(seg[i + 3]! - seg[i]!, seg[i + 4]! - seg[i + 1]!);
    }
    expect(length).toBeCloseTo(8, 9);
    // a plane that misses the box crosses nothing; positions are relative to the origin
    expect(sectionSegments(box, M4_IDENTITY, [0, 0, 1], -5, [0, 0, 0])).toHaveLength(0);
    expect(sectionSegments(box, M4_IDENTITY, [0, 0, 1], -1, [10, 0, 0])[0]).toBeLessThanOrEqual(-8);
  });

  it('turns a cut into a three.js clipping plane in render coordinates', () => {
    const plane = clipPlaneOf({ normal: [0, 0, 1], d: -1 }, [0, 0, 5]);
    // world z = 1 is render z = -4
    expect(plane.distanceToPoint({ x: 0, y: 0, z: -4 } as never)).toBeCloseTo(0, 9);
  });
});

describe('SectionLayer', () => {
  const sections = (over: Partial<RenderSections> = {}): RenderSections => ({
    ...EMPTY_SECTIONS,
    planes: [{ id: '/9', path: [], entityId: 9, corners: [[0, 0, 1], [2, 0, 1], [2, 2, 1], [0, 2, 1]], normal: [0, 0, -1], symbol: 'A', active: true, selected: false }],
    cuts: [{ key: '/9', path: [], normal: [0, 0, -1], d: 1 }],
    ...over,
  });

  it('clips everything inside a cut container, nested contexts included, and nothing outside it', () => {
    const layer = new SectionLayer();
    layer.set(sections({ cuts: [{ key: '7/9', path: [7], normal: [0, 0, -1], d: 1 }] }), [], [0, 0, 0], null);
    expect(layer.clipPlanesFor([])).toHaveLength(0);
    expect(layer.clipPlanesFor([7])).toHaveLength(1);
    expect(layer.clipPlanesFor([7, 8])).toHaveLength(1);
    expect(layer.clipPlanesFor([6])).toHaveLength(0);
  });

  it('draws a plane, the cut fill passes and the section lines', () => {
    const layer = new SectionLayer();
    const bodies = [{ body: body(), geometry: new BufferGeometry(), visible: true }];
    layer.set(sections(), bodies, [0, 0, 0], { min: [0, 0, 0], max: [2, 2, 2] });
    const names = (g: { children: { type: string }[] }) => g.children.map((c) => c.type);
    const [cuts, planes] = layer.group.children as unknown as [{ children: { type: string; renderOrder: number }[] }, { children: { type: string }[] }];
    // two stencil passes, the cap, the section lines
    expect(names(cuts)).toEqual(['Mesh', 'Mesh', 'Mesh', 'LineSegments2']);
    expect(cuts.children.map((c) => c.renderOrder)).toEqual([2, 2, 3, 4]);
    // fill quad, outline, and two symbols with arrows
    expect(planes.children.length).toBe(6);
    // no fill without the style switch
    layer.set(sections({ fill: false }), bodies, [0, 0, 0], { min: [0, 0, 0], max: [2, 2, 2] });
    expect(names(layer.group.children[0] as never)).toEqual(['LineSegments2']);
    layer.dispose();
  });
});
