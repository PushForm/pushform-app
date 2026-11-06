// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { M4_IDENTITY, meshBox } from '@pushform/core';
import { BufferGeometry, Group, Mesh, OrthographicCamera } from 'three';
import type { BufferAttribute } from 'three';
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
    // fill quad, outline, and a marker at each corner
    expect(planes.children.length).toBe(6);
    // no fill without the style switch
    layer.set(sections({ fill: false }), bodies, [0, 0, 0], { min: [0, 0, 0], max: [2, 2, 2] });
    expect(names(layer.group.children[0] as never)).toEqual(['LineSegments2']);
    layer.dispose();
  });

  it('draws a hidden plane shown with hidden geometry as an outline without its fill', () => {
    const layer = new SectionLayer();
    const hidden = sections().planes.map((p) => ({ ...p, hidden: true }));
    layer.set(sections({ planes: hidden, cuts: [] }), [], [0, 0, 0], { min: [0, 0, 0], max: [2, 2, 2] });
    const planes = layer.group.children[1] as unknown as { children: { type: string }[] };
    // outline and the four markers, no fill quad
    expect(planes.children.length).toBe(5);
    expect(planes.children[0]!.type).toBe('LineSegments2');
    layer.dispose();
  });

  /** The markers of the one plane drawn: groups placed at its corners. */
  const markers = (layer: SectionLayer): Group[] =>
    (layer.group.children[1] as Group).children.filter((c): c is Group => c instanceof Group);
  // troika labels are meshes too, told apart by their text
  const isLabel = (c: object): boolean => typeof (c as { text?: unknown }).text === 'string';
  const texts = (marker: Group): { text: string; y: number }[] =>
    marker.children.filter(isLabel).map((c) => ({ text: (c as unknown as { text: string }).text, y: c.position.y }));
  const shapes = (marker: Group): Mesh[] => marker.children.filter((c): c is Mesh => c instanceof Mesh && !isLabel(c));

  it('puts a bubble at each corner with the symbol over the sheet', () => {
    const layer = new SectionLayer();
    layer.set(sections(), [], [0, 0, 0], null);
    const all = markers(layer);
    expect(all.map((m) => m.position.toArray())).toEqual([[0, 0, 1], [2, 0, 1], [2, 2, 1], [0, 2, 1]]);
    // paper disc, ring, divider and arrow; the symbol alone in the top half
    expect(shapes(all[0]!)).toHaveLength(4);
    expect(texts(all[0]!)).toEqual([{ text: 'A', y: 0.45 }]);
    const sheeted = sections().planes.map((p) => ({ ...p, sheet: '3' }));
    layer.set(sections({ planes: sheeted }), [], [0, 0, 0], null);
    expect(texts(markers(layer)[2]!)).toEqual([{ text: 'A', y: 0.45 }, { text: '3', y: -0.45 }]);
    layer.dispose();
  });

  it('turns the markers to the camera at a fixed size and points each arrow to the kept side', () => {
    const layer = new SectionLayer();
    layer.set(sections(), [], [0, 0, 0], null);
    // looking along +y with z up: the kept side, -z, is straight down on screen
    const camera = new OrthographicCamera();
    camera.position.set(1, -10, 1);
    camera.up.set(0, 0, 1);
    camera.lookAt(1, 0, 1);
    camera.updateMatrixWorld();
    layer.update(camera, () => 0.01);
    const marker = markers(layer)[0]!;
    expect(marker.scale.x).toBeCloseTo(0.14, 9);
    // drawn a little toward the camera, which looks along +y
    expect(marker.position.y).toBeCloseTo(-0.28, 9);
    expect(marker.quaternion.angleTo(camera.quaternion)).toBeCloseTo(0, 6);
    const arrow = shapes(marker)[3]!;
    expect(arrow.visible).toBe(true);
    const tip = Array.from((arrow.geometry.getAttribute('position') as BufferAttribute).array.slice(0, 3));
    expect(tip[0]).toBeCloseTo(0, 6);
    expect(tip[1]).toBeLessThan(-1);
    // seen end on, from above, the arrow is not drawn
    camera.position.set(1, 1, 10);
    camera.up.set(0, 1, 0);
    camera.lookAt(1, 1, 0);
    camera.updateMatrixWorld();
    layer.update(camera, () => 0.01);
    expect(arrow.visible).toBe(false);
    layer.dispose();
  });
});
