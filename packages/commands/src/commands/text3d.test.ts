// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { DefId, MeshData } from '@pushform/core';
import { polygonArea } from '@pushform/geom';
import { InlineBackend, KernelClient, meshTopologyProblems } from '@pushform/kernel';
import type { DocumentState } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../host/services';
import { componentPlacement } from './components';
import { SERVICE_FONTS, text3dCommands, textOutlines } from './text3d';
import type { FontSource, Text3DResult } from './text3d';
import { parse } from 'opentype.js/dist/opentype.mjs';

const require = createRequire(import.meta.url);
const file = (name: string): ArrayBuffer => {
  const b = readFileSync(require.resolve(`@fontsource/roboto/files/${name}`));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
/** Roboto for every family: the tests check geometry, not typefaces. */
const fonts: FontSource = {
  load: (_font, bold) => {
    const w = bold ? 700 : 400;
    return Promise.resolve([file(`roboto-latin-${w}-normal.woff`), file(`roboto-latin-ext-${w}-normal.woff`)]);
  },
};
const roboto = () => [parse(file('roboto-latin-400-normal.woff')), parse(file('roboto-latin-ext-400-normal.woff'))];

const kernels: KernelClient[] = [];
afterEach(() => {
  for (const k of kernels.splice(0)) k.dispose();
  componentPlacement.current = null;
});

function setup(withTools = false) {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const activated: string[] = [];
  const services = new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel], [SERVICE_FONTS, fonts]]);
  const registry = new CommandRegistry({ tx: host, services, ...(withTools ? { tools: { activate: (id: string) => activated.push(id) } as never } : {}) });
  registry.registerAll(editCommands);
  registry.registerAll(text3dCommands);
  const create = (p: Record<string, unknown>) => registry.execute('text3d.create', p) as Promise<Text3DResult>;
  return { host, create, activated, state: (): DocumentState => host.doc.state };
}

/** Enclosed volume by the divergence theorem. */
function volume(m: MeshData): number {
  let v = 0;
  for (let i = 0; i < m.tris.length; i += 3) {
    const p = [0, 1, 2].map((k) => [m.verts[3 * m.tris[i + k]!]!, m.verts[3 * m.tris[i + k]! + 1]!, m.verts[3 * m.tris[i + k]! + 2]!]);
    const [a, b, c] = p as [number[], number[], number[]];
    v += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
  }
  return v;
}

describe('3D Text outlines', () => {
  it('sets capitals at the given height with the lower-left corner at the origin', () => {
    const polys = textOutlines(roboto(), 'H', { height: 0.5, align: 'left' });
    expect(polys).toHaveLength(1);
    const ys = polys[0]![0]!.map((p) => p[1]!), xs = polys[0]![0]!.map((p) => p[0]!);
    expect(Math.min(...ys)).toBeCloseTo(0, 9);
    expect(Math.max(...ys)).toBeCloseTo(0.5, 6);
    expect(Math.min(...xs)).toBeCloseTo(0, 9);
  });

  it('keeps counters as holes: "o" is one outline with one hole, "B" has two', () => {
    expect(textOutlines(roboto(), 'o', { height: 1, align: 'left' }).map((p) => p.length)).toEqual([2]);
    expect(textOutlines(roboto(), 'B', { height: 1, align: 'left' }).map((p) => p.length)).toEqual([3]);
    // "i" is two outlines (stem and dot)
    expect(textOutlines(roboto(), 'i', { height: 1, align: 'left' }).map((p) => p.length)).toEqual([1, 1]);
  });

  it('stacks lines downward and aligns them within the widest', () => {
    const minX = (polys: number[][][][], below: number) =>
      Math.min(...polys.filter((p) => Math.max(...p[0]!.map((q) => q[1]!)) < below).flatMap((p) => p[0]!.map((q) => q[0]!)));
    const left = textOutlines(roboto(), 'WWWW\nI', { height: 1, align: 'left' });
    const right = textOutlines(roboto(), 'WWWW\nI', { height: 1, align: 'right' });
    const center = textOutlines(roboto(), 'WWWW\nI', { height: 1, align: 'center' });
    // the second line's "I" sits below the first line
    expect(minX(left, 1.01)).toBeLessThan(0.3);
    expect(minX(right, 1.01)).toBeGreaterThan(minX(center, 1.01));
    expect(minX(center, 1.01)).toBeGreaterThan(minX(left, 1.01));
  });

  it('takes characters the Latin file lacks from Latin Extended', () => {
    // U+0110 (Đ) is only in the latin-ext subset
    expect(roboto()[0]!.charToGlyph('Đ').index).toBe(0);
    expect(textOutlines(roboto(), 'Đ', { height: 1, align: 'left' }).length).toBeGreaterThan(0);
  });

});

describe('3D Text command', () => {
  it('extrudes each outline into a closed solid whose volume is its area times the depth', async () => {
    const { create, state } = setup();
    const { definitionId } = await create({ text: 'o', height: 1, extrude: 0.25 });
    const def = state().definitions.get(definitionId as DefId)!;
    const bodies = [...def.entities.bodies.values()];
    expect(bodies).toHaveLength(1);
    const area = polygonArea(textOutlines(roboto(), 'o', { height: 1, align: 'left' })[0]!);
    expect(volume(bodies[0]!.mesh)).toBeCloseTo(area * 0.25, 6);
    expect(meshTopologyProblems(bodies[0]!.mesh)).toEqual([]);
    // curved sides are soft; cap edges stay hard
    const edges = [...bodies[0]!.edges.values()];
    expect(edges.some((e) => e.soft)).toBe(true);
    expect(edges.some((e) => !e.soft)).toBe(true);
  });

  it('extrudes every printable ASCII and Latin-1 character into closed solids', async () => {
    const { create, state } = setup();
    let text = '';
    for (let c = 0x21; c < 0x7f; c++) text += String.fromCharCode(c);
    for (let c = 0xc0; c <= 0xff; c++) text += String.fromCharCode(c);
    const { definitionId } = await create({ text, height: 0.1, extrude: 0.01 });
    const bodies = [...state().definitions.get(definitionId as DefId)!.entities.bodies.values()];
    const polys = textOutlines(roboto(), text, { height: 0.1, align: 'left' });
    expect(bodies.length).toBe(polys.length);
    for (const b of bodies) expect(meshTopologyProblems(b.mesh)).toEqual([]);
    const area = polys.reduce((a, p) => a + polygonArea(p), 0);
    expect(bodies.reduce((v, b) => v + volume(b.mesh), 0)).toBeCloseTo(area * 0.01, 7);
  });

  it('extrudes below the plane when the depth is negative', async () => {
    const { create, state } = setup();
    const { definitionId } = await create({ text: 'I', height: 1, extrude: -0.5 });
    const body = [...state().definitions.get(definitionId as DefId)!.entities.bodies.values()][0]!;
    const zs = [...body.mesh.verts].filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(-0.5, 9);
    expect(Math.max(...zs)).toBeCloseTo(0, 9);
    expect(volume(body.mesh)).toBeGreaterThan(0);
  });

  it('fills flat text with faces that carry the counters as holes', async () => {
    const { create, state } = setup();
    const { definitionId } = await create({ text: 'oB', height: 1 });
    const sketch = state().definitions.get(definitionId as DefId)!.entities.sketch;
    expect(state().definitions.get(definitionId as DefId)!.entities.bodies.size).toBe(0);
    expect([...sketch.faces.values()].map((f) => f.loops.length).sort()).toEqual([2, 3]);
  });

  it('leaves only edges when not filled', async () => {
    const { create, state } = setup();
    const { definitionId } = await create({ text: 'o', height: 1, filled: false });
    const sketch = state().definitions.get(definitionId as DefId)!.entities.sketch;
    expect(sketch.faces.size).toBe(0);
    expect(sketch.edges.size).toBeGreaterThan(8);
  });

  it('makes a component named after the text in one undo step, placed at a point', async () => {
    const { host, create, state } = setup();
    const before = state().definitions.size;
    const { definitionId, instanceId } = await create({ text: 'Hi\nthere', height: 1, extrude: 0.1, point: [1, 2, 3] });
    const def = state().definitions.get(definitionId as DefId)!;
    expect(def.name).toBe('Hi');
    expect(def.isGroup).toBe(false);
    const inst = state().definitions.get(state().rootDefinitionId)!.entities.instances.get(instanceId as never)!;
    expect([...inst.transform].slice(12, 15)).toEqual([1, 2, 3]);
    expect(host.selection.refs).toEqual([{ kind: 'instance', path: [], id: instanceId }]);
    host.undo();
    expect(state().definitions.size).toBe(before);
  });

  it('hands the component to the Place Component tool when no point is given', async () => {
    const { create, activated, state } = setup(true);
    const { definitionId, instanceId } = await create({ text: 'A', height: 1 });
    expect(instanceId).toBeNull();
    expect(componentPlacement.current).toBe(definitionId);
    expect(activated).toEqual(['placeComponent']);
    expect(state().definitions.get(state().rootDefinitionId)!.entities.instances.size).toBe(0);
  });

  it('refuses text with nothing to draw', async () => {
    const { create } = setup();
    expect(() => create({ text: '   ' })).toThrow(/Enter some text/);
  });
});
