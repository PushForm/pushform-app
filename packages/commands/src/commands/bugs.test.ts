// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import type { Body } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../host/services';
import { sketchCommands } from './sketch';
import { curveCommands } from './curves';
import { pushPullCommands } from './pushpull';
import { solidCommands } from './solids';
import { followMeCommands } from './followme';

function circle(c: [number, number, number], n: [number, number, number], r: number, segs: number) {
  const u: [number, number, number] = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const w = [v[1]! * n[2] - v[2]! * n[1], v[2]! * n[0] - v[0]! * n[2], v[0]! * n[1] - v[1]! * n[0]];
  const pts: [number, number, number][] = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pts.push([c[0] + r * (v[0]! * Math.cos(a) + w[0]! * Math.sin(a)), c[1] + r * (v[1]! * Math.cos(a) + w[1]! * Math.sin(a)), c[2] + r * (v[2]! * Math.cos(a) + w[2]! * Math.sin(a))]);
  }
  return pts;
}

function setup() {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  const commands = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  commands.registerAll([...sketchCommands, ...curveCommands, ...pushPullCommands, ...solidCommands, ...followMeCommands]);
  const root = () => host.doc.rootDefinition.entities;
  const bodies = () => [...root().bodies.values()];
  return { host, commands, root, bodies };
}

async function cylinder(s: ReturnType<typeof setup>, center: [number, number, number], r: number): Promise<Body> {
  const before = new Set(s.bodies().map((b) => b.id));
  s.commands.execute('sketch.addCurve', { points: circle(center, [0, 0, 1], r, 24), closed: true, curve: { kind: 'circle', center, normal: [0, 0, 1], radius: r, segments: 24 } });
  const faceId = [...s.root().sketch.faces.keys()].pop()!;
  await s.commands.execute('pushpull.apply', { target: { kind: 'sketchFace', path: [], id: faceId }, distance: -1, mode: 'merge' });
  return s.bodies().find((b) => !before.has(b.id))!;
}
async function box(s: ReturnType<typeof setup>, min: [number, number, number], max: [number, number, number]): Promise<Body> {
  const before = new Set(s.bodies().map((b) => b.id));
  s.commands.execute('sketch.rectangle', { a: [min[0], min[1], min[2]], b: [max[0], min[1], min[2]], c: [max[0], max[1], min[2]], d: [min[0], max[1], min[2]] });
  const faceId = [...s.root().sketch.faces.keys()].pop()!;
  await s.commands.execute('pushpull.apply', { target: { kind: 'sketchFace', path: [], id: faceId }, distance: -(max[2] - min[2]), mode: 'merge' });
  return s.bodies().find((b) => !before.has(b.id))!;
}
const softCount = (b: Body) => [...b.edges.values()].filter((e) => e.soft && e.smooth).length;

describe('Solid Tools keep soft edges and surfaces', () => {
  it('union keeps the cylinder smooth whether it is the kept body or the other one', async () => {
    const s = setup();
    const cyl = await cylinder(s, [0, 0, 0], 0.5);
    const bx = await box(s, [0.2, -0.6, 0], [1.5, 0.6, 0.4]);
    expect(cyl.surfaces.size).toBe(1);
    expect(softCount(cyl)).toBe(24);
    // cylinder is `b` (the other body): its attributes must still carry over
    await s.commands.execute('solids.union', { a: { kind: 'body', path: [], id: bx.id }, b: { kind: 'body', path: [], id: cyl.id } });
    const merged = s.bodies().find((b) => b.faces.size > 20)!;
    expect(s.bodies()).toHaveLength(1);
    expect(merged.surfaces.size).toBe(1);
    expect(softCount(merged)).toBeGreaterThanOrEqual(20);
    expect(merged.valid).toBe(true);
  });
  it('subtract keeps the surviving cylinder surface', async () => {
    const s = setup();
    const cyl = await cylinder(s, [0, 0, 0], 0.5);
    const bx = await box(s, [0.2, -0.6, 0], [1.5, 0.6, 0.4]);
    await s.commands.execute('solids.subtract', { a: { kind: 'body', path: [], id: bx.id }, b: { kind: 'body', path: [], id: cyl.id } });
    const cut = s.bodies()[0]!;
    expect(cut.surfaces.size).toBe(1);
    expect(softCount(cut)).toBeGreaterThanOrEqual(20);
  });
});

describe('Follow Me from a face of a solid merges into it', () => {
  it('sweeps a circle drawn on the box side along a path and unions the result', async () => {
    const s = setup();
    const bx = await box(s, [0, 0, 0], [1, 1, 1]);
    const vol0 = bx.props.volume;
    // profile circle on the +x face (x = 1), path arc going outward in the XZ plane
    s.commands.execute('sketch.addCurve', { points: circle([1, 0.5, 0.3], [1, 0, 0], 0.08, 12), closed: true, curve: { kind: 'circle', center: [1, 0.5, 0.3], normal: [1, 0, 0], radius: 0.08, segments: 12 } });
    const body = s.bodies()[0]!;
    const side = [...body.faces.values()].find((f) => f.plane.n[0] > 0.99)!;
    expect(body.imprints.get(side.id)?.edges.size).toBe(12);
    const arc: [number, number, number][] = [];
    for (let i = 0; i <= 8; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / 8;
      arc.push([1 + 0.3 * Math.cos(a), 0.5, 0.6 + 0.3 * Math.sin(a)]);
    }
    const r = (await s.commands.execute('followme.apply', {
      profile: { kind: 'face', path: [], id: body.id, faceId: side.id, region: 1 },
      pathPoints: arc,
    })) as { bodyIds: number[] };
    expect(s.bodies()).toHaveLength(1);
    expect(r.bodyIds).toEqual([body.id]);
    const after = s.bodies()[0]!;
    expect(after.valid).toBe(true);
    expect(after.props.volume).toBeGreaterThan(vol0 + 0.005);
    expect(s.host.undoStack.length).toBeGreaterThan(0);
    s.host.undo();
    expect(s.bodies()[0]!.props.volume).toBeCloseTo(vol0, 6);
  });
});
