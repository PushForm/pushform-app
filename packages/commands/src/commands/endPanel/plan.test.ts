// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { BuilderPlanError } from '../builders/parts';
import { planEndPanel } from './plan';

const inch = 0.0254;
const refused = (run: () => unknown): BuilderPlanError => {
  try { run(); } catch (e) { if (e instanceof BuilderPlanError) return e; throw e; }
  throw new Error('expected a refusal');
};
const panel = (plan: ReturnType<typeof planEndPanel>) => plan.parts.find(p => p.name === 'End Panel')!;
const notch = (plan: ReturnType<typeof planEndPanel>) => {
  const shape = panel(plan).shape;
  return shape.kind === 'stock' ? shape.cuts : [];
};

describe('planEndPanel', () => {
  it('covers a base cabinet at the origin, flush with its doors', () => {
    const plan = planEndPanel({});
    expect(plan.at).toEqual([-0.75 * inch, -0.75 * inch, 0]);
    panel(plan).size.forEach((v, i) => expect(v).toBeCloseTo([34.5, 24, 0.75][i]! * inch, 9));
  });

  it('notches a floor panel at the front bottom for the toe kick', () => {
    const cuts = notch(planEndPanel({}));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.max[0]).toBeCloseTo(4 * inch, 9);
    expect(cuts[0]!.max[1]).toBeCloseTo(3.75 * inch, 9);
    expect(cuts[0]!.max[2]).toBeCloseTo(0.75 * inch, 9);
    expect(panel(planEndPanel({})).x).toEqual([0, 0, 1]);
  });

  it('takes the notch away or resizes it when told', () => {
    expect(notch(planEndPanel({ toeKick: false }))).toHaveLength(0);
    const cuts = notch(planEndPanel({ toeKick: { height: 3 * inch } }));
    expect(cuts[0]!.max[0]).toBeCloseTo(3 * inch, 9);
    expect(cuts[0]!.max[1]).toBeCloseTo(3.75 * inch, 9);
  });

  it('hangs a wall panel with no notch, twelve inches deep', () => {
    const plan = planEndPanel({ type: 'wall' });
    expect(plan.at[2]).toBeCloseTo(54 * inch, 9);
    expect(panel(plan).size[1]).toBeCloseTo(12 * inch, 9);
    expect(notch(plan)).toHaveLength(0);
  });

  it('notches a tall panel, which also stands on the floor', () => {
    expect(notch(planEndPanel({ type: 'tall' }))).toHaveLength(1);
  });

  it('follows a thinner skin at the default position', () => {
    const plan = planEndPanel({ thickness: 0.25 * inch });
    expect(plan.at[0]).toBeCloseTo(-0.25 * inch, 9);
    expect(panel(plan).size[2]).toBeCloseTo(0.25 * inch, 9);
  });

  it('refuses a wall toe kick, two finishes and a notch that leaves no panel', () => {
    expect(refused(() => planEndPanel({ type: 'wall', toeKick: true })).code).toBe('invalid_operation');
    expect(planEndPanel({ type: 'wall', toeKick: false }).parts).toHaveLength(1);
    expect(refused(() => planEndPanel({ finish: { paint: '#ffffff', stain: 'x' } })).code).toBe('invalid_operation');
    expect(refused(() => planEndPanel({ toeKick: { height: 30 * inch } })).code).toBe('invalid_geometry');
    expect(refused(() => planEndPanel({ depth: 4 * inch })).code).toBe('invalid_geometry');
    expect(refused(() => planEndPanel({ thickness: 2 * inch })).code).toBe('invalid_geometry');
  });
});
