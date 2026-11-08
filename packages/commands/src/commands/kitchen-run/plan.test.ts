// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { BuilderPlanError } from '../builders/parts';
import type { BuilderPlan } from '../builders/parts';
import { planKitchenRun } from './plan';
import type { KitchenRunParams } from './plan';

const inch = 0.0254, i = (n: number) => n * inch;
const child = (plan: BuilderPlan, name: string): BuilderPlan => {
  const found = plan.children!.find(c => c.name === name);
  if (!found) throw new Error(`no ${name} in ${plan.children!.map(c => c.name).join(', ')}`);
  return found;
};
const refused = (params: KitchenRunParams): BuilderPlanError => {
  try { planKitchenRun(params); } catch (e) { if (e instanceof BuilderPlanError) return e; throw e; }
  throw new Error('expected a refusal');
};
const l = (style: 'diagonal' | 'l_shaped' | 'blind', side: 'left' | 'right'): KitchenRunParams => ({
  base: [{ width: i(24) }, { width: i(30) }], corner: { style, side, returnBase: [{ width: i(24) }, { width: i(18) }] },
});

describe('planKitchenRun', () => {
  it('lays a straight run left to right, wall row at its height, one countertop', () => {
    const plan = planKitchenRun({ base: [{ width: i(24) }, { width: i(30) }], wall: [{ width: i(36) }] });
    expect(child(plan, 'Base 2').at).toEqual([i(24), 0, 0]);
    expect(child(plan, 'Wall 1').at[2]).toBeCloseTo(i(54), 9);
    expect(child(plan, 'Wall 1').at[1]).toBeCloseTo(i(23.25 - 11.25), 9);
    expect(child(plan, 'Countertop').parts[0]!.size[0]).toBeCloseTo(i(54), 9);
    expect(plan.used).toMatchObject({ overallWidth: i(54) });
  });

  it('breaks the countertop at a range and carries it over a dishwasher', () => {
    const plan = planKitchenRun({ base: [{ width: i(24) }, { width: i(30), appliance: 'range' }, { width: i(24), appliance: 'dishwasher' }, { width: i(24) }] });
    expect(child(plan, 'Countertop 1').parts[0]!.size[0]).toBeCloseTo(i(24), 9);
    expect(child(plan, 'Countertop 2').parts[0]!.size[0]).toBeCloseTo(i(48), 9);
    expect(plan.children!.some(c => c.name === 'Base 2')).toBe(false);
  });

  it('cuts a sink opening over a sink base', () => {
    const shape = child(planKitchenRun({ base: [{ width: i(24) }, { width: i(36), sinkFront: true }] }), 'Countertop').parts[0]!.shape;
    expect(shape.kind === 'stock' && shape.cuts).toHaveLength(1);
  });

  it('backs a diagonal corner into the room corner and turns the return to face in', () => {
    const plan = planKitchenRun(l('diagonal', 'left'));
    expect(child(plan, 'Base Corner').at).toEqual([0, i(23.25 - 36), 0]);
    const first = child(plan, 'Return Base 1');
    expect(first.rotationDeg).toBe(90);
    expect(first.at[0]).toBeCloseTo(i(23.25), 9);
    expect(first.at[1]).toBeCloseTo(i(23.25 - 36 - 24), 9);
    expect(child(plan, 'Base 1').at[0]).toBeCloseTo(i(36), 9);
  });

  it('mirrors a right corner to the other end, turned the other way', () => {
    const plan = planKitchenRun(l('l_shaped', 'right'));
    expect(child(plan, 'Base Corner').at[0]).toBeCloseTo(i(54), 9);
    const first = child(plan, 'Return Base 1');
    expect(first.rotationDeg).toBe(-90);
    expect(first.at[0]).toBeCloseTo(i(90 - 23.25), 9);
    expect(first.at[1]).toBeCloseTo(i(23.25 - 36), 9);
  });

  it('adds a filler where a return meets a blind corner, clear of its door', () => {
    const plan = planKitchenRun(l('blind', 'left'));
    const filler = plan.parts.find(p => p.name === 'Return Base Filler')!;
    expect(filler.size[1]).toBeCloseTo(i(3), 9);
    expect(child(plan, 'Return Base 1').at[1]).toBeCloseTo(-i(0.75 + 3 + 24), 9);
  });

  it('runs one L-shaped countertop around the corner', () => {
    const counter = child(planKitchenRun(l('diagonal', 'left')), 'Countertop');
    expect(counter.used).toMatchObject({ leg: { side: 'left' } });
    expect(counter.at[1]).toBeLessThan(-i(1.75));
  });

  it('angles the countertop to follow a diagonal corner, with the same overhang', () => {
    for (const side of ['left', 'right'] as const) {
      const top = child(planKitchenRun(l('diagonal', side)), 'Countertop');
      expect(top.used).toMatchObject({ leg: { chamfer: expect.closeTo(i(36 + 1.75 * (Math.SQRT2 - 1) - 25), 9) } });
      const shape = top.parts[0]!.shape;
      expect(shape.kind).toBe('prism');
      if (shape.kind === 'prism') expect(shape.outline).toHaveLength(7);
    }
    expect(child(planKitchenRun(l('l_shaped', 'left')), 'Countertop').parts[0]!.shape.kind).toBe('stock');
    expect(child(planKitchenRun(l('blind', 'left')), 'Countertop').parts[0]!.shape.kind).toBe('stock');
  });

  it('refuses a sink on the return, a narrow blind corner, and an empty base', () => {
    expect(refused({ base: [{ width: i(24) }], corner: { style: 'diagonal', returnBase: [{ width: i(36), sinkFront: true }] } }).code).toBe('invalid_operation');
    expect(refused({ base: [{ width: i(24) }], corner: { style: 'blind', width: i(36), returnBase: [{ width: i(24) }] } }).code).toBe('invalid_geometry');
    expect(refused({ base: [] }).code).toBe('invalid_operation');
  });
});
