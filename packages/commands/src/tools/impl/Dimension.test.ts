// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Box3, Id, Ray, Vec2, Vec3 } from '@pushform/core';
import { tessellateArc, tessellateCircle } from '@pushform/geom';
import { freeInference, GROUND_PLANE } from '@pushform/inference';
import type { InferenceResult, PickHit, Snap } from '@pushform/inference';
import { SketchGraph } from '@pushform/model';
import type { Dimension, EntityRef } from '@pushform/model';
import { CommandRegistry } from '../../registry/CommandRegistry';
import { editCommands } from '../../registry/editCommands';
import { sketchCommands } from '../../commands/sketch';
import { curveCommands, type AddCurveResult } from '../../commands/curves';
import { dimensionCommands } from '../../commands/dimensions';
import { DocumentHost } from '../../host/DocumentHost';
import { SERVICE_DOCUMENT } from '../../host/services';
import type { CameraHost, CameraState } from '../../camera/CameraHost';
import { ToolManager } from '../ToolManager';
import { NO_MODIFIERS } from '../Tool';
import type { ToolPointerEvent } from '../Tool';
import { constructionTools } from '../constructionTools';

const CAMERA: CameraState = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 35, projection: 'parallel', orthoHeight: 6 };

class StubCamera implements CameraHost {
  getState(): CameraState { return CAMERA; }
  setState(): void {}
  viewportSize() { return { width: 800, height: 600 }; }
  screenToRay(): Ray { return { origin: [0, 0, 10], dir: [0, 0, -1] }; }
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

function setup() {
  const host = new DocumentHost();
  const camera = new StubCamera();
  const registry = new CommandRegistry({ tx: host, camera, services: new Map([[SERVICE_DOCUMENT, host]]) });
  for (const commands of [editCommands, sketchCommands, curveCommands, dimensionCommands]) registry.registerAll(commands);
  const tools = new ToolManager(registry, camera);
  registry.ctx.tools = tools;
  for (const t of constructionTools()) tools.register(t);
  const root = () => host.doc.rootDefinition.entities;
  const dims = (): Dimension[] => [...root().dimensions.values()];
  const vertexAt = (p: Vec3): Id => [...root().sketch.vertices.values()].find((v) => v.p.every((x, i) => Math.abs(x - p[i]!) < 1e-9))!.id;
  return { host, registry, tools, root, dims, vertexAt };
}

/** Pointer event at world point `p` with a free inference, or the given snap and hit. */
function at(p: Vec3, opts: { hit?: PickHit | null; snap?: Partial<Snap> } = {}): ToolPointerEvent {
  const screen: Vec2 = [400 + p[0] * 100, 300 - p[1] * 100];
  const base = freeInference(p, GROUND_PLANE, opts.hit ?? null);
  const inference: InferenceResult = opts.snap ? { ...base, primary: { ...base.primary, ...opts.snap, point: p } as Snap } : base;
  return { screen, ray: { origin: [p[0], p[1], 10], dir: [0, 0, -1] }, button: 0, buttons: 1, modifiers: NO_MODIFIERS, inference, camera: CAMERA };
}
const endpoint = (ref: EntityRef): Partial<Snap> => ({ kind: 'endpoint', ref, color: '', label: 'Endpoint' });
const edgeHit = (id: Id, p: Vec3): PickHit => ({ ref: { kind: 'sketchEdge', path: [], id }, point: p, t: 10, screenDist: 1 });

describe('DimensionTool', () => {
  it('dimensions two vertices, attached to them, with the line offset toward the pointer', () => {
    const { host, tools, dims, vertexAt } = setup();
    host.edit('Edge', (draft) => { SketchGraph.for(draft).addEdge([0, 0, 0], [2, 0, 0]); });
    const a = vertexAt([0, 0, 0]), b = vertexAt([2, 0, 0]);
    tools.activate('dimension');
    expect(tools.status().instructor).toContain('first point');
    tools.click(at([0, 0, 0], { snap: endpoint({ kind: 'sketchVertex', path: [], id: a }) }));
    expect(tools.status().instructor).toContain('second point');
    tools.click(at([2, 0, 0], { snap: endpoint({ kind: 'sketchVertex', path: [], id: b }) }));
    tools.pointerMove(at([1, 0.7, 0]));
    expect(tools.overlay().some((o) => o.kind === 'label')).toBe(true);
    tools.click(at([1, 0.7, 0]));
    const [dim] = dims();
    expect(dim).toMatchObject({ kind: 'linear', start: [0, 0, 0], end: [2, 0, 0], anchors: [{ kind: 'sketchVertex', id: a }, { kind: 'sketchVertex', id: b }] });
    dim!.offset.forEach((v, i) => expect(v).toBeCloseTo([0, 0.7, 0][i]!, 9));
    expect(Math.abs(dim!.normal[2])).toBeCloseTo(1, 9);
    expect(tools.status().instructor).toContain('first point');
  });

  it('dimensions an edge by its two ends; points picked off a vertex stay free', () => {
    const { host, tools, dims, root } = setup();
    host.edit('Edge', (draft) => { SketchGraph.for(draft).addEdge([0, 0, 0], [0, 3, 0]); });
    const edge = [...root().sketch.edges.values()][0]!;
    tools.activate('dimension');
    tools.click(at([0, 1.5, 0], { hit: edgeHit(edge.id, [0, 1.5, 0]) }));
    tools.click(at([-1, 1, 0]));
    expect(dims()[0]).toMatchObject({ start: [0, 0, 0], end: [0, 3, 0], anchors: [{ kind: 'sketchVertex', id: edge.a }, { kind: 'sketchVertex', id: edge.b }] });
    tools.click(at([5, 5, 0]));
    tools.click(at([6, 5, 0]));
    tools.click(at([6, 6, 0]));
    expect(dims()[1]).toMatchObject({ start: [5, 5, 0], end: [6, 5, 0], anchors: [null, null] });
  });

  it('dimensions a circle by its diameter and an arc by its radius, attached to the curve', () => {
    const { registry, tools, dims, root } = setup();
    const circle = tessellateCircle([0, 0, 0], [0, 0, 1], 1, 24);
    const c = registry.execute('sketch.addCurve', { points: circle.points, closed: true, curve: circle.curve }) as AddCurveResult;
    const arc = tessellateArc([5, 0, 0], [0, 0, 1], 2, 0, Math.PI / 2, 8);
    const a = registry.execute('sketch.addCurve', { points: arc.points, closed: false, curve: arc.curve }) as AddCurveResult;
    const edgeOf = (curveId: number) => [...root().sketch.edges.values()].find((e) => e.curveId === curveId)!;
    tools.activate('dimension');
    tools.click(at([1, 0, 0], { hit: edgeHit(edgeOf(c.curveId).id, [1, 0, 0]) }));
    expect(tools.status().instructor).toContain('diameter');
    tools.click(at([3, 0, 0]));
    const diameter = dims()[0]!;
    expect(diameter).toMatchObject({ kind: 'diametric', curve: { path: [], bodyId: null, curveId: c.curveId } });
    diameter.start.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0][i]!, 9));
    diameter.end.forEach((v, i) => expect(v).toBeCloseTo([-1, 0, 0][i]!, 9));
    diameter.offset.forEach((v, i) => expect(v).toBeCloseTo([2, 0, 0][i]!, 9));
    tools.click(at([5, 2, 0], { hit: edgeHit(edgeOf(a.curveId).id, [5, 2, 0]) }));
    tools.click(at([5, 3, 0]));
    const radius = dims()[1]!;
    expect(radius).toMatchObject({ kind: 'radial', start: [5, 0, 0], curve: { curveId: a.curveId } });
    radius.end.forEach((v, i) => expect(v).toBeCloseTo([5, 2, 0][i]!, 9));
  });

  it('cancels with Escape without adding anything', () => {
    const { tools, dims } = setup();
    tools.activate('dimension');
    tools.click(at([0, 0, 0]));
    tools.cancel();
    expect(tools.status().instructor).toContain('first point');
    tools.click(at([1, 1, 0]));
    tools.click(at([2, 1, 0]));
    expect(dims()).toEqual([]);
  });
});
