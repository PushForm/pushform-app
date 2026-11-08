// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@pushform/core';
import { CabinetPlanError, planCabinet } from './plan';
import type { CabinetParams, CabinetPart, CabinetPlan } from './plan';
import { inches as i } from './dimensions';

const named = (plan: CabinetPlan, name: string, assembly: string | null = null): CabinetPart => {
  const part = plan.parts.find(p => p.name === name && p.assembly === assembly);
  if (!part) throw new Error(`no ${assembly ?? 'box'}/${name} in ${plan.parts.map(p => `${p.assembly}/${p.name}`).join(', ')}`);
  return part;
};
/** The part's box in the cabinet's coordinates. */
function bounds(p: CabinetPart): { min: Vec3; max: Vec3 } {
  const far = [0, 1, 2].map(k => p.origin[k]! + p.x[k]! * p.size[0] + p.y[k]! * p.size[1] + p.z[k]! * p.size[2]);
  return { min: [0, 1, 2].map(k => Math.min(p.origin[k]!, far[k]!)) as unknown as Vec3, max: [0, 1, 2].map(k => Math.max(p.origin[k]!, far[k]!)) as unknown as Vec3 };
}
const closeTo = (actual: number, inchesExpected: number): void => { expect(actual / 0.0254).toBeCloseTo(inchesExpected, 6); };
const refused = (params: CabinetParams): CabinetPlanError => {
  try { planCabinet(params); } catch (e) { if (e instanceof CabinetPlanError) return e; throw e; }
  throw new Error('expected a refusal');
};

describe('planCabinet defaults', () => {
  it('builds a base cabinet from type and width alone', () => {
    const plan = planCabinet({ type: 'base', width: i(24) });
    expect(plan.used).toMatchObject({ frame: 'frameless', overlay: 'full', doorStyle: 'shaker', doors: 1, drawers: 1, shelves: 1, toeKick: true, back: true, at: [0, 0, 0] });
    closeTo(plan.used.height, 34.5);
    closeTo(plan.used.depth, 23.25);
    expect(plan.name).toBe('Base Cabinet 24 in');
    for (const name of ['Left Side', 'Right Side', 'Bottom', 'Front Stretcher', 'Rear Stretcher', 'Back', 'Toe Kick', 'Shelf']) named(plan, name);
    for (const name of ['Left Stile', 'Right Stile', 'Top Rail', 'Bottom Rail', 'Panel']) named(plan, name, 'Door');
    for (const name of ['Front', 'Box Left Side', 'Box Right Side', 'Box Front', 'Box Back', 'Box Bottom']) named(plan, name, 'Drawer');
  });

  it('gives wall and tall cabinets their own defaults', () => {
    const wall = planCabinet({ type: 'wall', width: i(30) });
    expect(wall.used).toMatchObject({ doors: 2, drawers: 0, shelves: 2, toeKick: false, at: [0, 0, i(54)] });
    closeTo(wall.used.depth, 11.25);
    named(wall, 'Top');
    expect(planCabinet({ type: 'wall', width: i(30), height: i(42) }).used.shelves).toBe(3);
    const tall = planCabinet({ type: 'tall', width: i(18) });
    expect(tall.used).toMatchObject({ doors: 1, shelves: 4, toeKick: true });
    closeTo(tall.used.height, 84);
  });

  it('fills a drawer base with graduated rows, deepest at the bottom', () => {
    const plan = planCabinet({ type: 'base', width: i(18), doors: 0 });
    expect(plan.used).toMatchObject({ doors: 0, drawers: 3, shelves: 0 });
    const heights = ['Drawer 1', 'Drawer 2', 'Drawer 3'].map(a => plan.parts.filter(p => p.assembly === a && p.role === 'show').reduce((h, p) => Math.max(h, bounds(p).max[2] - bounds(p).min[2]), 0));
    expect(heights[0]).toBeLessThan(heights[1]!);
    expect(heights[1]).toBeLessThan(heights[2]!);
  });
});

describe('planCabinet fronts', () => {
  it('sizes frameless doors with 1/16 edges and a 1/8 gap', () => {
    const one = planCabinet({ type: 'wall', width: i(18), doorStyle: 'slab' });
    closeTo(named(one, 'Slab', 'Door').size[1], 18 - 1 / 8);
    const two = planCabinet({ type: 'wall', width: i(36), doorStyle: 'slab' });
    closeTo(named(two, 'Slab', 'Left Door').size[1], (36 - 1 / 4) / 2);
    closeTo(bounds(named(two, 'Slab', 'Right Door')).min[0] - bounds(named(two, 'Slab', 'Left Door')).max[0], 1 / 8);
  });

  it('overlays a partial door 1/2 in over its face frame opening', () => {
    const plan = planCabinet({ type: 'wall', width: i(18), frame: 'face_frame', doorStyle: 'slab' });
    expect(plan.used.overlay).toBe('partial');
    closeTo(named(plan, 'Slab', 'Door').size[1], 18 - 3 + 1);
  });

  it('sets an inset door flush in its opening with 1/16 reveals', () => {
    const plan = planCabinet({ type: 'wall', width: i(18), frame: 'face_frame', overlay: 'inset', doorStyle: 'slab' });
    const door = bounds(named(plan, 'Slab', 'Door'));
    closeTo(door.max[0] - door.min[0], 18 - 3 - 1 / 8);
    closeTo(door.min[1], 0);
    closeTo(door.max[1], 3 / 4);
  });

  it('leaves 1/8 between full overlay doors on a face frame', () => {
    const plan = planCabinet({ type: 'wall', width: i(36), frame: 'face_frame', overlay: 'full', doorStyle: 'slab' });
    closeTo(bounds(named(plan, 'Slab', 'Right Door')).min[0] - bounds(named(plan, 'Slab', 'Left Door')).max[0], 1 / 8);
    closeTo(bounds(named(plan, 'Slab', 'Left Door')).min[0], 1.5 - 1.25);
  });

  it('sizes a shaker panel to its opening plus two groove depths less 1/8', () => {
    const plan = planCabinet({ type: 'wall', width: i(18) });
    const door = named(plan, 'Left Stile', 'Door').size[0];
    closeTo(named(plan, 'Panel', 'Door').size[0] - door, -4.5 + 3 / 4 - 1 / 8);
    closeTo(named(plan, 'Panel', 'Door').size[2], 1 / 4);
  });

  it('runs door panels vertical and drawer-front panels horizontal', () => {
    const door = planCabinet({ type: 'wall', width: i(18) });
    expect(named(door, 'Panel', 'Door').x).toEqual([0, 0, 1]);
    const drawers = planCabinet({ type: 'base', width: i(24), doors: 0, drawers: 2 });
    expect(named(drawers, 'Panel', 'Drawer 2').x).toEqual([1, 0, 0]);
    expect(named(drawers, 'Top Rail', 'Drawer 2').x).toEqual([1, 0, 0]);
    expect(named(drawers, 'Left Stile', 'Drawer 2').x).toEqual([0, 0, 1]);
  });

  it('makes a short drawer front a slab on a shaker cabinet', () => {
    const plan = planCabinet({ type: 'base', width: i(24) });
    named(plan, 'Front', 'Drawer');
    expect(plan.parts.some(p => p.assembly === 'Drawer' && p.name === 'Panel')).toBe(false);
  });

  it('puts the field of a raised panel just behind the frame face', () => {
    const plan = planCabinet({ type: 'wall', width: i(18), doorStyle: 'raised' });
    const panel = bounds(named(plan, 'Panel', 'Door')), stile = bounds(named(plan, 'Left Stile', 'Door'));
    closeTo(panel.min[1] - stile.min[1], 1 / 16);
    closeTo(panel.max[1] - panel.min[1], 5 / 8);
  });

  it('builds tall drawers below the door', () => {
    const plan = planCabinet({ type: 'tall', width: i(24), drawers: 2 });
    expect(bounds(named(plan, 'Front', 'Drawer 1')).max[2]).toBeLessThan(bounds(named(plan, 'Left Stile', 'Door')).min[2]);
  });

  it('replaces the drawer of a sink base with a false front and no box', () => {
    const plan = planCabinet({ type: 'base', width: i(36), sinkFront: true });
    named(plan, 'False Front');
    expect(plan.parts.some(p => p.name.startsWith('Box'))).toBe(false);
  });
});

describe('planCabinet parts', () => {
  const sweep: CabinetParams[] = [];
  for (const type of ['base', 'wall', 'tall'] as const) for (const frame of ['frameless', 'face_frame'] as const) for (const doorStyle of ['slab', 'shaker', 'raised', 'none'] as const) for (const width of [i(15), i(24), i(36), i(48)]) {
    sweep.push({ type, width, frame, doorStyle });
    if (frame === 'face_frame') sweep.push({ type, width, frame, doorStyle, overlay: 'inset' }, { type, width, frame, doorStyle, overlay: 'full' });
    if (type === 'base') sweep.push({ type, width, frame, doorStyle, doors: 0, drawers: 4 });
  }

  it('keeps every part positive, whole and proper over a sweep of parameters', () => {
    for (const params of sweep) {
      const plan = planCabinet(params);
      for (const part of plan.parts) {
        expect(part.size.every(s => s > 0), `${part.name} of ${JSON.stringify(params)}`).toBe(true);
        expect(part.size[0] * 0 + part.x[0] ** 2 + part.x[1] ** 2 + part.x[2] ** 2).toBe(1);
      }
    }
  });

  it('never lets two parts interpenetrate apart from a panel in its groove', () => {
    for (const params of sweep) {
      const plan = planCabinet(params), boxes = plan.parts.map(p => ({ p, b: bounds(p) }));
      for (let a = 0; a < boxes.length; a++) for (let c = a + 1; c < boxes.length; c++) {
        const A = boxes[a]!, C = boxes[c]!;
        const overlap = [0, 1, 2].every(k => Math.min(A.b.max[k]!, C.b.max[k]!) - Math.max(A.b.min[k]!, C.b.min[k]!) > 1e-6);
        if (!overlap) continue;
        const panelInFrame = A.p.assembly === C.p.assembly && [A.p.name, C.p.name].includes('Panel');
        const backInSide = [A.p.name, C.p.name].includes('Back') && [A.p.name, C.p.name].some(n => n.endsWith(' Side'));
        const notchedSide = [A.p.name, C.p.name].includes('Toe Kick') && [A.p.name, C.p.name].some(n => n.endsWith(' Side'));
        expect(panelInFrame || backInSide || notchedSide, `${A.p.assembly}/${A.p.name} and ${C.p.assembly}/${C.p.name} in ${JSON.stringify(params)}`).toBe(true);
      }
    }
  });

  it('keeps the box within its envelope and the doors in front of it', () => {
    const plan = planCabinet({ type: 'base', width: i(30) });
    for (const p of plan.parts) {
      const b = bounds(p);
      expect(b.min[0]).toBeGreaterThanOrEqual(-1e-9);
      expect(b.max[0]).toBeLessThanOrEqual(plan.used.width + 1e-9);
      expect(b.max[1]).toBeLessThanOrEqual(plan.used.depth + 1e-9);
      expect(b.max[2]).toBeLessThanOrEqual(plan.used.height + 1e-9);
    }
    closeTo(bounds(named(plan, 'Left Stile', 'Left Door')).min[1], -3 / 4);
  });

  it('notches the sides for the toe kick and rabbets them for the back', () => {
    const plan = planCabinet({ type: 'base', width: i(24) });
    const shape = named(plan, 'Left Side').shape;
    expect(shape.kind === 'stock' && shape.cuts.length).toBe(2);
    closeTo(bounds(named(plan, 'Toe Kick')).min[1], 3);
    closeTo(bounds(named(plan, 'Bottom')).min[2], 4);
  });

  it('marks only the asked ends as finished', () => {
    const plan = planCabinet({ type: 'base', width: i(24), finishedEnds: 'right' });
    expect(named(plan, 'Left Side').finishedOutside).toBe(false);
    expect(named(plan, 'Right Side').finishedOutside).toBe(true);
  });
});

describe('planCabinet refusals', () => {
  it('names the fix for contradictions', () => {
    expect(refused({ type: 'base', width: i(24), overlay: 'inset' })).toMatchObject({ code: 'invalid_operation', message: expect.stringContaining('face_frame') });
    expect(refused({ type: 'base', width: i(24), doorStyle: 'none', doors: 1 }).code).toBe('invalid_operation');
    expect(refused({ type: 'wall', width: i(24), toeKick: true }).code).toBe('invalid_operation');
    expect(refused({ type: 'wall', width: i(24), sinkFront: true }).code).toBe('invalid_operation');
    expect(refused({ type: 'base', width: i(24), sinkFront: true, drawers: 2 }).code).toBe('invalid_operation');
    expect(refused({ type: 'base', width: i(24), doors: 0, drawers: 3, shelves: 1 }).code).toBe('invalid_operation');
    expect(refused({ type: 'base', width: i(24), finish: { paint: '#ffffff', stain: 'x' } }).code).toBe('invalid_operation');
  });

  it('steers sizes it cannot build to the other operations', () => {
    const wide = refused({ type: 'base', width: i(60) });
    expect(wide.code).toBe('invalid_geometry');
    expect(wide.message).toContain('add_box');
    expect(refused({ type: 'wall', width: i(9), doors: 2 }).code).toBe('invalid_geometry');
    expect(refused({ type: 'wall', width: i(24), height: i(12), drawers: 2, doors: 1 }).code).toBe('invalid_geometry');
    expect(refused({ type: 'wall', width: i(24), height: i(12), shelves: 8 }).code).toBe('invalid_geometry');
  });
});
