// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { Box3, Id, Ray, Vec3 } from '@pushform/core';
import { DEFAULT_UNITS, formatLength } from '@pushform/core';
import { tessellateArc, tessellateCircle } from '@pushform/geom';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { bodyVertexFaces, dimensionText, resolveDimension, SketchGraph } from '@pushform/model';
import type { Body, Dimension, EntityContainer } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import type { CameraHost, CameraState } from '../camera/CameraHost';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../host/services';
import { modelCommands } from './model';
import { pushPullCommands } from './pushpull';
import { sketchCommands } from './sketch';
import { curveCommands, type AddCurveResult } from './curves';
import { dimensionCommands } from './dimensions';
import { transformCommands } from './transform';
import { m4mul, m4rotationAxis, m4translation } from '@pushform/core';

class FakeCamera implements CameraHost {
  state: CameraState = { eye: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 10 };
  getState(): CameraState { return this.state; }
  setState(s: CameraState): void { this.state = s; }
  viewportSize(): { width: number; height: number } { return { width: 800, height: 600 }; }
  screenToRay(): Ray { return { origin: [0, 0, 0], dir: [0, 0, -1] }; }
  pick(): Vec3 | null { return null; }
  sceneBounds(): Box3 | null { return null; }
  orbitStart(): void {}
  orbitDrag(): void {}
  orbitEnd(): void {}
  panStart(): void {}
  panDrag(): void {}
  panEnd(): void {}
  zoomAt(): void {}
  zoomExtents(): void {}
  zoomWindow(): void {}
  standardView(): void {}
  setProjection(): void {}
  setFov(): void {}
  setFocalLength(): void {}
  previousView(): boolean { return false; }
  nextView(): boolean { return false; }
}

const kernels: KernelClient[] = [];
afterEach(() => { for (const k of kernels.splice(0)) k.dispose(); });

function setup() {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const registry = new CommandRegistry({ tx: host, camera: new FakeCamera(), services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  for (const commands of [editCommands, modelCommands, sketchCommands, curveCommands, pushPullCommands, dimensionCommands, transformCommands]) registry.registerAll(commands);
  const root = (): EntityContainer => host.doc.rootDefinition.entities;
  const dims = (): Dimension[] => [...root().dimensions.values()];
  const resolved = (d: Dimension) => resolveDimension(host.doc.state, root(), d);
  return { host, registry, root, dims, resolved };
}

describe('dimension.add', () => {
  it('attaches to sketch vertices, follows them, and undoes as one step', () => {
    const { host, registry, root, dims, resolved } = setup();
    host.edit('Edge', (draft) => { SketchGraph.for(draft).addEdge([0, 0, 0], [2, 0, 0]); });
    const vertexAt = (p: Vec3): Id => [...root().sketch.vertices.values()].find((v) => v.p[0] === p[0] && v.p[1] === p[1])!.id;
    const a = vertexAt([0, 0, 0]), b = vertexAt([2, 0, 0]);
    registry.execute('dimension.add', { kind: 'linear', start: [0, 0, 0], end: [2, 0, 0], offset: [0, -0.5, 0], normal: [0, 0, 1],
      anchors: [{ kind: 'sketchVertex', path: [], id: a }, { kind: 'sketchVertex', path: [], id: b }] });
    const [dim] = dims();
    expect(dim).toMatchObject({ kind: 'linear', text: null, fontSizePt: 10, offset: [0, -0.5, 0] });
    expect(resolved(dim!).value).toBeCloseTo(2, 12);

    // Moving the end vertex re-measures the dimension.
    host.edit('Move vertex', (draft) => { draft.definitions.get(draft.rootDefinitionId)!.entities.sketch.vertices.get(b)!.p = [3, 0, 0]; });
    expect(resolved(dims()[0]!).end).toEqual([3, 0, 0]);
    expect(dimensionText(dims()[0]!, resolved(dims()[0]!).value, DEFAULT_UNITS)).toBe(formatLength(3, DEFAULT_UNITS));
    host.undo();
    host.undo();
    expect(dims()).toEqual([]);
  });

  it('follows a solid corner by its faces through Push/Pull', async () => {
    const { registry, root, dims, resolved } = setup();
    registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] });
    const body = (): Body => [...root().bodies.values()][0]!;
    const corner = (p: Vec3) => ({ kind: 'bodyVertex' as const, path: [], bodyId: body().id, faceIds: bodyVertexFaces(body(), p) });
    expect(corner([1, 0, 1]).faceIds).toHaveLength(3);
    registry.execute('dimension.add', { kind: 'linear', start: [0, 0, 0], end: [1, 0, 1], offset: [0, -0.3, 0], normal: [0, 1, 0],
      anchors: [corner([0, 0, 0]), corner([1, 0, 1])] });
    const top = [...body().faces.values()].find((f) => f.plane.n[2] > 0.99)!;
    await registry.execute('pushpull.apply', { target: { kind: 'face', path: [], id: body().id, faceId: top.id, region: null }, distance: 1, mode: 'merge' });
    const at = resolved(dims()[0]!);
    expect(at.start).toEqual([0, 0, 0]);
    expect(at.end[2]).toBeCloseTo(2, 9);
    expect(at.value).toBeCloseTo(Math.sqrt(5), 9);
  });

  it('measures arcs and circles by radius and diameter, with R and DIA', () => {
    const { registry, dims, resolved } = setup();
    const circle = tessellateCircle([0, 0, 0], [0, 0, 1], 1.5, 24);
    const c = registry.execute('sketch.addCurve', { points: circle.points, closed: true, curve: circle.curve }) as AddCurveResult;
    const arc = tessellateArc([5, 0, 0], [0, 0, 1], 0.5, 0, Math.PI / 2, 8);
    const a = registry.execute('sketch.addCurve', { points: arc.points, closed: false, curve: arc.curve }) as AddCurveResult;
    registry.execute('dimension.add', { kind: 'diametric', start: [1.5, 0, 0], end: [-1.5, 0, 0], offset: [1, 1, 0], normal: [0, 0, 1],
      curve: { path: [], bodyId: null, curveId: c.curveId } });
    registry.execute('dimension.add', { kind: 'radial', start: [5, 0, 0], end: [5.5, 0, 0], offset: [0.5, 0, 0], normal: [0, 0, 1],
      curve: { path: [], bodyId: null, curveId: a.curveId } });
    const [diameter, radius] = dims();
    expect(resolved(diameter!).value).toBeCloseTo(3, 9);
    expect(dimensionText(diameter!, resolved(diameter!).value, DEFAULT_UNITS)).toBe(`DIA ${formatLength(3, DEFAULT_UNITS)}`);
    expect(dimensionText(radius!, resolved(radius!).value, DEFAULT_UNITS)).toBe(`R ${formatLength(0.5, DEFAULT_UNITS)}`);
  });

  it('refuses coincident points; Delete and dimension.delete remove dimensions', () => {
    const { host, registry, dims } = setup();
    expect(() => registry.execute('dimension.add', { kind: 'linear', start: [1, 1, 1], end: [1, 1, 1], offset: [0, 1, 0], normal: [0, 0, 1] })).toThrow('two distinct points');
    const first = registry.execute('dimension.add', { kind: 'linear', start: [0, 0, 0], end: [1, 0, 0], offset: [0, 1, 0], normal: [0, 0, 1] }) as Id;
    const second = registry.execute('dimension.add', { kind: 'linear', start: [0, 0, 0], end: [0, 1, 0], offset: [1, 0, 0], normal: [0, 0, 1] }) as Id;
    host.selection.set([{ kind: 'dimension', path: [], id: first }]);
    registry.execute('edit.delete', {});
    expect(dims().map((d) => d.id)).toEqual([second]);
    expect(registry.execute('dimension.delete', { ids: [second] })).toBe(1);
    expect(dims()).toEqual([]);
    expect(host.doc.rootDefinition.entities.order).not.toContain(second);
  });
});

describe('dimension settings, editing and moving', () => {
  const linear = { kind: 'linear', start: [0, 0, 0], end: [2, 0, 0], offset: [0, -0.5, 0], normal: [0, 0, 1] } as const;

  it('gives new dimensions the model settings, and Update Selected Dimensions restyles chosen ones', () => {
    const { host, registry, dims } = setup();
    const before = registry.execute('dimension.add', linear) as Id;
    expect(dims()[0]).toMatchObject({ fontSizePt: 10, arrow: 'closed', align: 'screen' });
    expect(registry.execute('model.setDimensionStyle', { arrow: 'dot', align: 'above', fontSizePt: 14 })).toEqual({ fontSizePt: 14, arrow: 'dot', align: 'above' });
    const after = registry.execute('dimension.add', { ...linear, end: [0, 3, 0], offset: [0.5, 0, 0] }) as Id;
    const byId = (id: Id) => dims().find((d) => d.id === id)!;
    expect(byId(after)).toMatchObject({ fontSizePt: 14, arrow: 'dot', align: 'above' });
    // Existing dimensions keep their own style until updated.
    expect(byId(before)).toMatchObject({ arrow: 'closed', align: 'screen' });
    host.selection.set([{ kind: 'dimension', path: [], id: before }]);
    expect(registry.execute('dimension.setStyle', {})).toBe(1);
    expect(byId(before)).toMatchObject({ fontSizePt: 14, arrow: 'dot', align: 'above' });
    registry.execute('dimension.setStyle', { refs: [{ kind: 'dimension', path: [], id: before }], arrow: 'slash' });
    expect(byId(before).arrow).toBe('slash');
    host.undo();
    host.undo();
    expect(byId(before)).toMatchObject({ arrow: 'closed', align: 'screen' });
    host.undo();
    host.undo();
    expect(host.doc.state.meta.dimensions).toBeUndefined();
  });

  it('edits text with <> for the measurement, empty text shows the measurement, and switches radius and diameter', () => {
    const { host, registry, dims, resolved } = setup();
    const id = registry.execute('dimension.add', linear) as Id;
    const ref = { kind: 'dimension', path: [], id };
    registry.execute('dimension.edit', { ref, text: 'Wall <>' });
    expect(dimensionText(dims()[0]!, 2, DEFAULT_UNITS)).toBe(`Wall ${formatLength(2, DEFAULT_UNITS)}`);
    registry.execute('dimension.edit', { ref, text: '  ' });
    expect(dims()[0]!.text).toBeNull();
    expect(() => registry.execute('dimension.edit', { ref, type: 'diametric' })).toThrow('arc or circle');
    host.undo();
    expect(dims()[0]!.text).toBe('Wall <>');

    const circle = tessellateCircle([10, 0, 0], [0, 0, 1], 1.5, 24);
    const c = registry.execute('sketch.addCurve', { points: circle.points, closed: true, curve: circle.curve }) as AddCurveResult;
    const r = registry.execute('dimension.add', { kind: 'radial', start: [10, 0, 0], end: [11.5, 0, 0], offset: [1, 1, 0], normal: [0, 0, 1],
      curve: { path: [], bodyId: null, curveId: c.curveId } }) as Id;
    const radial = () => dims().find((d) => d.id === r)!;
    registry.execute('dimension.edit', { ref: { kind: 'dimension', path: [], id: r }, type: 'diametric' });
    expect(radial().kind).toBe('diametric');
    expect(resolved(radial()).value).toBeCloseTo(3, 9);
    // The leader still starts at the same point on the circle.
    expect(resolved(radial()).start[0]).toBeCloseTo(11.5, 9);
    expect(radial().offset).toEqual([1, 1, 0]);
    registry.execute('dimension.edit', { ref: { kind: 'dimension', path: [], id: r }, type: 'radial' });
    expect(radial()).toMatchObject({ kind: 'radial' });
    expect(resolved(radial()).value).toBeCloseTo(1.5, 9);
    expect(resolved(radial()).end[0]).toBeCloseTo(11.5, 9);
  });

  it('moved on its own keeps its points and attachments and moves its dimension line; with geometry it moves whole', async () => {
    const { host, registry, root, dims, resolved } = setup();
    host.edit('Edge', (draft) => { SketchGraph.for(draft).addEdge([0, 0, 0], [2, 0, 0]); });
    const vertexAt = (p: Vec3): Id => [...root().sketch.vertices.values()].find((v) => v.p[0] === p[0] && v.p[1] === p[1])!.id;
    const id = registry.execute('dimension.add', { ...linear, anchors: [{ kind: 'sketchVertex', path: [], id: vertexAt([0, 0, 0]) }, { kind: 'sketchVertex', path: [], id: vertexAt([2, 0, 0]) }] }) as Id;
    const ref = { kind: 'dimension' as const, path: [], id };
    // Alone: only the part across the measured segment moves the line; along it and out of its plane do nothing.
    await registry.execute('transform.apply', { refs: [ref], matrix: m4translation([0.7, -0.4, 3]) });
    expect(dims()[0]!.offset[1]).toBeCloseTo(-0.9, 12);
    expect(dims()[0]!.offset[0]).toBeCloseTo(0, 12);
    expect(dims()[0]!.offset[2]).toBeCloseTo(0, 12);
    expect(resolved(dims()[0]!)).toMatchObject({ start: [0, 0, 0], end: [2, 0, 0] });
    expect(dims()[0]!.anchors).toHaveLength(2);
    // With the edge it measures: the whole dimension moves, and it still follows its vertices.
    await registry.execute('transform.apply', { refs: [ref, { kind: 'sketchEdge', path: [], id: [...root().sketch.edges.keys()][0]! }], matrix: m4translation([0, 5, 0]) });
    expect(resolved(dims()[0]!).start).toEqual([0, 5, 0]);
    expect(dims()[0]!.start).toEqual([0, 5, 0]);
    // Turned on its own, it turns whole.
    await registry.execute('transform.apply', { refs: [ref], matrix: m4mul(m4translation([0, 5, 0]), m4mul(m4rotationAxis([0, 0, 1], Math.PI / 2), m4translation([0, -5, 0]))) });
    expect(dims()[0]!.offset[0]).toBeCloseTo(0.9, 9);
    // A copy is unattached.
    await registry.execute('transform.apply', { refs: [ref], matrix: m4translation([0, 0, 1]), copy: true });
    const copy = dims().find((d) => d.id !== id)!;
    expect(copy.anchors).toBeUndefined();
    expect(copy.start[2]).toBeCloseTo(1, 12);
    host.undo();
    expect(dims()).toHaveLength(1);
  });
});
