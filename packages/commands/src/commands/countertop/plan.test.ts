// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { BuilderPlanError } from '../builders/parts';
import { planCountertop } from './plan';

const inch = 0.0254;
const refused = (run: () => unknown): BuilderPlanError => {
  try { run(); } catch (e) { if (e instanceof BuilderPlanError) return e; throw e; }
  throw new Error('expected a refusal');
};
const main = (plan: ReturnType<typeof planCountertop>) => plan.parts.find(p => p.name === 'Countertop')!;

describe('planCountertop', () => {
  it('sits on a base cabinet at the origin by default, 1 in past its doors', () => {
    const plan = planCountertop({ width: 48 * inch });
    expect(plan.at[1]).toBeCloseTo(-1.75 * inch, 9);
    expect(plan.at[2]).toBeCloseTo(34.5 * inch, 9);
    expect(main(plan).size).toEqual([48 * inch, 25 * inch, 1.5 * inch]);
  });

  it('cuts a sink opening through the slab', () => {
    const shape = main(planCountertop({ width: 48 * inch, cutouts: [{ x: 12 * inch, width: 24 * inch }] })).shape;
    expect(shape.kind === 'stock' && shape.cuts).toHaveLength(1);
    if (shape.kind === 'stock') {
      expect(shape.cuts[0]!.min[0]).toBeCloseTo(12 * inch, 9);
      expect(shape.cuts[0]!.max[2]).toBeCloseTo(1.5 * inch, 9);
    }
  });

  it('makes an L by notching the corner opposite its leg', () => {
    const left = main(planCountertop({ width: 96 * inch, leg: { side: 'left', length: 60 * inch } }));
    expect(left.size[1]).toBeCloseTo(85 * inch, 9);
    if (left.shape.kind === 'stock') expect(left.shape.cuts[0]!.min[0]).toBeCloseTo(25 * inch, 9);
    const right = main(planCountertop({ width: 96 * inch, leg: { side: 'right', length: 60 * inch } }));
    if (right.shape.kind === 'stock') expect(right.shape.cuts[0]!.max[0]).toBeCloseTo(71 * inch, 9);
  });

  it('angles the inside corner of an L and keeps sink openings', () => {
    const shape = main(planCountertop({ width: 96 * inch, leg: { side: 'left', length: 60 * inch, chamfer: 12 * inch }, cutouts: [{ x: 40 * inch, width: 30 * inch }] })).shape;
    expect(shape.kind).toBe('prism');
    if (shape.kind === 'prism') {
      expect(shape.outline[2]![1]).toBeCloseTo(48 * inch, 9);
      expect(shape.outline[3]![0]).toBeCloseTo(37 * inch, 9);
      expect(shape.holes).toHaveLength(1);
    }
  });

  it('refuses a chamfer larger than its corner', () => {
    expect(refused(() => planCountertop({ width: 96 * inch, leg: { side: 'left', length: 10 * inch, chamfer: 12 * inch } })).code).toBe('invalid_geometry');
  });

  it('stands a backsplash on the back edge', () => {
    const plan = planCountertop({ width: 48 * inch, backsplash: 4 * inch });
    const splash = plan.parts.find(p => p.name === 'Backsplash')!;
    expect(splash.origin[2]).toBeCloseTo(1.5 * inch, 9);
    expect(splash.size[1]).toBeCloseTo(4 * inch, 9);
  });

  it('refuses a cutout too close to an edge, and two finishes', () => {
    expect(refused(() => planCountertop({ width: 30 * inch, cutouts: [{ x: 0.5 * inch, width: 10 * inch }] })).code).toBe('invalid_geometry');
    expect(refused(() => planCountertop({ width: 30 * inch, finish: { paint: '#ffffff', library: 'x' } })).code).toBe('invalid_operation');
  });
});
