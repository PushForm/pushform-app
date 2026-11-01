// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Mat4 } from '@pushform/core';
import { LineSegments, Mesh, type MeshLambertMaterial } from 'three';
import { ImportPreviewLayer, type ImportPreviewPart } from './ImportPreviewLayer';

/** A unit cube part (two triangles per face are not needed here: one triangle and one edge do). */
const cube = (id: number, color: [number, number, number] | null = null): ImportPreviewPart => ({
  id, color,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 1]),
  triangles: new Uint32Array([0, 1, 2]),
  edges: new Float32Array([0, 0, 0, 1, 0, 0]),
});
const translate = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

describe('ImportPreviewLayer', () => {
  it('shares one geometry per part across its placements and grows its world bounds', () => {
    const layer = new ImportPreviewLayer();
    layer.begin();
    expect(layer.worldBounds()).toBeNull();
    expect(layer.add({ parts: [cube(0)], placements: [{ part: 0, matrix: translate(0, 0, 0) }, { part: 0, matrix: translate(5, 0, 0) }] })).toBe(true);
    const meshes = layer.group.children.filter((c): c is Mesh => c instanceof Mesh);
    expect(meshes).toHaveLength(2);
    expect(meshes[0]!.geometry).toBe(meshes[1]!.geometry);
    expect(layer.group.children.filter(c => c instanceof LineSegments)).toHaveLength(2);
    expect(layer.worldBounds()).toEqual({ min: [0, 0, 0], max: [6, 1, 1] });
  });

  it('holds a placement until its part arrives, and colors parts by their own color', () => {
    const layer = new ImportPreviewLayer();
    layer.begin();
    expect(layer.add({ parts: [], placements: [{ part: 3, matrix: translate(0, 0, 2) }] })).toBe(false);
    expect(layer.isEmpty).toBe(true);
    expect(layer.add({ parts: [cube(3, [0, 0, 1])], placements: [] })).toBe(true);
    const mesh = layer.group.children.find((c): c is Mesh => c instanceof Mesh)!;
    const color = (mesh.material as MeshLambertMaterial).color;
    expect([color.r, color.g, color.b]).toEqual([0, 0, 1]);
    expect(layer.worldBounds()).toEqual({ min: [0, 0, 2], max: [1, 1, 3] });
  });

  it('places parts in the frame of the destination and follows the floating origin', () => {
    const layer = new ImportPreviewLayer();
    layer.begin(translate(10, 0, 0) as unknown as Mat4);
    layer.add({ parts: [cube(0)], placements: [{ part: 0, matrix: translate(0, 1, 0) }] });
    expect(layer.worldBounds()!.min).toEqual([10, 1, 0]);
    const mesh = layer.group.children.find((c): c is Mesh => c instanceof Mesh)!;
    expect(mesh.matrix.elements.slice(12, 15)).toEqual([10, 1, 0]);
    layer.setOrigin([10, 0, 0]);
    expect(mesh.matrix.elements.slice(12, 15)).toEqual([0, 1, 0]);
  });

  it('clears everything for the next import', () => {
    const layer = new ImportPreviewLayer();
    layer.begin();
    layer.add({ parts: [cube(0)], placements: [{ part: 0, matrix: translate(0, 0, 0) }] });
    expect(layer.clear()).toBe(true);
    expect(layer.group.children).toHaveLength(0);
    expect(layer.worldBounds()).toBeNull();
    expect(layer.clear()).toBe(false);
  });
});
