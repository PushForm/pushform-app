// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { DASH_PATTERN_TOL } from '@pushform/core';

const MM_PER_PT = 25.4 / 72;
type Step = number | 'dot';

/**
 * Stroke patterns by the id .layout files store (`strokeDashPattern`), as alternating dash and gap
 * lengths in units of the stroke weight. Dashes and gaps grow with
 * the pattern scale; a dot stays one unit long. The file format stores dash-dash-dot as 8 and dash-dash-dot-dot as 7.
 */
export const LAYOUT_DASH_PATTERNS: readonly { id: number; name: string; steps: readonly Step[] }[] = [
  { id: 1, name: 'Dash', steps: [12, 6] },
  { id: 12, name: 'Short dash', steps: [6, 6] },
  { id: 2, name: 'Dot', steps: ['dot', 6] },
  { id: 3, name: 'Dash dot', steps: [12, 6, 'dot', 6] },
  { id: 4, name: 'Dash dot dot', steps: [12, 6, 'dot', 6, 'dot', 6] },
  { id: 6, name: 'Dash dot dot dot', steps: [12, 6, 'dot', 6, 'dot', 6, 'dot', 6] },
  { id: 8, name: 'Dash dash dot', steps: [12, 6, 12, 6, 'dot', 6] },
  { id: 7, name: 'Dash dash dot dot', steps: [12, 6, 12, 6, 'dot', 6, 'dot', 6] },
  { id: 9, name: 'Dash dash dot dot dot', steps: [12, 6, 12, 6, 'dot', 6, 'dot', 6, 'dot', 6] },
  { id: 10, name: 'Center', steps: [36, 10, 12, 10] },
  { id: 11, name: 'Phantom', steps: [36, 10, 12, 10, 12, 10] },
];

/** The dash unit: the stroke weight, but never under 0.75 pt, so hairlines still show their pattern. */
function dashUnitMm(weightPt: number): number {
  return Math.max(weightPt, 0.75) * MM_PER_PT;
}

/** Dash and gap lengths in paper millimeters for a pattern id (unknown ids draw as a plain dash). */
export function layoutDashMm(id: number, weightPt: number, scale = 1): number[] {
  const pattern = LAYOUT_DASH_PATTERNS.find(p => p.id === id) ?? LAYOUT_DASH_PATTERNS[0]!;
  const unit = dashUnitMm(weightPt);
  return pattern.steps.map(step => step === 'dot' ? unit : step * unit * scale);
}

/** The pattern and scale that draw these dash lengths at this weight, or null when none does. */
export function matchLayoutDash(dashMm: readonly number[], weightPt: number): { id: number; scale: number } | null {
  const unit = dashUnitMm(weightPt);
  for (const pattern of LAYOUT_DASH_PATTERNS) {
    if (pattern.steps.length !== dashMm.length) continue;
    const first = pattern.steps.findIndex(step => step !== 'dot');
    // Six figures drop the drift of recomputing lengths, so a pattern keeps its exact scale through edits.
    const scale = Number((dashMm[first]! / (pattern.steps[first] as number) / unit).toPrecision(6));
    const close = (a: number, b: number) => Math.abs(a - b) <= DASH_PATTERN_TOL * Math.max(a, b);
    if (scale > 0 && pattern.steps.every((step, i) => close(dashMm[i]!, step === 'dot' ? unit : step * unit * scale))) return { id: pattern.id, scale };
  }
  return null;
}

/**
 * The pattern nearest to arbitrary dash lengths (from DXF linetypes, say): dot-led shapes become
 * dots, long-short shapes center lines, others plain dashes, scaled to keep the repeat length.
 */
export function nearestLayoutDash(dashMm: readonly number[], weightPt: number): { id: number; scale: number } {
  const exact = matchLayoutDash(dashMm, weightPt);
  if (exact) return exact;
  const unit = dashUnitMm(weightPt), period = dashMm.reduce((sum, n) => sum + n, 0);
  const dashes = dashMm.filter((_, i) => i % 2 === 0), longest = Math.max(...dashes), shortest = Math.min(...dashes);
  const id = longest <= unit * 1.5 ? 2 : dashes.length > 1 && shortest < longest / 2 ? 3 : 1;
  const pattern = LAYOUT_DASH_PATTERNS.find(p => p.id === id)!;
  const dots = pattern.steps.filter(step => step === 'dot').length;
  const scaled = pattern.steps.reduce<number>((sum, step) => sum + (step === 'dot' ? 0 : step), 0);
  return { id, scale: Math.max((period - dots * unit) / (scaled * unit), Number.EPSILON) };
}
