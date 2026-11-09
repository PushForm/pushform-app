// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import type { CutBox, PanelRing } from './mesh';

/** A span along one axis, in meters. */
export interface Range { readonly from: number; readonly to: number }
export const range = (from: number, to: number): Range => ({ from, to });
export const span = (r: Range): number => r.to - r.from;
export type Pt = readonly [number, number];

/** How a planned part's solid is made, in the part's own axes. */
export type BuilderShape =
  | { readonly kind: 'stock'; readonly cuts: readonly CutBox[] }
  | { readonly kind: 'lofted'; readonly rings: readonly PanelRing[] }
  /** A profile in the part's y-z plane, counter-clockwise from +x, run along its length. */
  | { readonly kind: 'section'; readonly outline: readonly Pt[] }
  | { readonly kind: 'prism'; readonly outline: readonly Pt[]; readonly round: boolean; readonly holes?: readonly (readonly Pt[])[] };

/** One solid. Its local axes are x along its length and grain, y across its width and z through its thickness. */
export interface BuilderPart {
  readonly name: string;
  /** The named assembly holding the part, or null for a part directly in the plan's group. */
  readonly assembly: string | null;
  readonly size: Vec3;
  readonly shape: BuilderShape;
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
  /** Which of the plan's materials the solid takes. */
  readonly role: string;
  /** A material role for the part's local +z face alone. */
  readonly plusZRole?: string | undefined;
  /** A material role for the part's local z = 0 face alone. */
  readonly zeroFaceRole?: string | undefined;
}

/** A material a plan needs: a library key, or a paint color reused by name across a model. */
export type MaterialSpec = { readonly library: string } | { readonly paint: string; readonly roughness?: number | undefined };

/** The same material gets the same key, wherever in a plan's tree it is named. */
export const materialKey = (spec: MaterialSpec): string => ('library' in spec ? `library:${spec.library}` : `paint:${spec.paint}${spec.roughness === undefined ? "" : `:roughness=${spec.roughness}`}`);

/** A reusable component, mounted with its local origin on the front plane and projecting toward -y. */
export interface BuilderPlacement {
  readonly name: string;
  readonly assembly: string;
  readonly definitionId: number;
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

/**
 * What a builder produces: pure data, made without touching a document. Generating it makes one named group at `at`,
 * turned `rotationDeg` about +z, holding the parts and any child plans.
 */
export interface BuilderPlan<Used = unknown> {
  readonly name: string;
  readonly at: Vec3;
  readonly rotationDeg?: number;
  /** Every parameter as resolved, reported back to the client. */
  readonly used: Used;
  readonly parts: readonly BuilderPart[];
  readonly children?: readonly BuilderPlan[];
  readonly placements?: readonly BuilderPlacement[];
  readonly materials: Readonly<Record<string, MaterialSpec>>;
}

/** Parameters that cannot make a plan; `code` says whether they contradict each other or cannot make sound parts. */
export class BuilderPlanError extends Error {
  constructor(readonly code: 'invalid_operation' | 'invalid_geometry', message: string) { super(message); this.name = 'BuilderPlanError'; }
}

export type Axis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
const AXES: Record<Axis, Vec3> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export interface PartOptions {
  readonly cuts?: readonly CutBox[];
  readonly rings?: readonly PanelRing[];
  readonly section?: readonly Pt[] | undefined;
  readonly plusZRole?: string | undefined;
  readonly zeroFaceRole?: string | undefined;
}

/**
 * Collects a plan's parts. The local axes are always a right-handed rotation of the plan's axes, so no part is ever
 * placed mirrored and a cut list reads its length, width and thickness from its definition.
 */
export class Builder {
  constructor(readonly parts: BuilderPart[] = [], private readonly face: { readonly at: Pt; readonly u: Pt } | null = null) {}

  /** A builder whose x runs from `p` to `q` and whose y is 0 on that line, with -y facing out of the object. */
  onFace(p: Pt, q: Pt): Builder {
    const dx = q[0] - p[0], dy = q[1] - p[1], length = Math.hypot(dx, dy);
    return new Builder(this.parts, { at: p, u: [dx / length, dy / length] });
  }

  private place(v: Vec3): Vec3 {
    if (!this.face) return v;
    const { u } = this.face;
    return [v[0] * u[0] - v[1] * u[1], v[0] * u[1] + v[1] * u[0], v[2]];
  }

  /** Mount a component in this front plane, including diagonal and return faces. */
  mount(name: string, assembly: string, definitionId: number, origin: Vec3, vertical: boolean): BuilderPlacement {
    const p = this.place(origin);
    return { name, assembly, definitionId, origin: this.face ? [p[0] + this.face.at[0], p[1] + this.face.at[1], p[2]] : p,
      x: this.place(vertical ? [0, 0, 1] : [1, 0, 0]), y: this.place(vertical ? [0, 1, 0] : [0, 1, 0]),
      z: this.place(vertical ? [-1, 0, 0] : [0, 0, 1]) };
  }

  /** Add the part filling a box of this builder's space, with its length and width along the given axes. */
  add(name: string, assembly: string | null, role: string, x: Range, y: Range, z: Range, length: Axis, width: Axis, options: PartOptions = {}): void {
    const extent: Vec3 = [span(x), span(y), span(z)];
    const lo: Vec3 = [x.from, y.from, z.from], hi: Vec3 = [x.to, y.to, z.to];
    const u = AXES[length], v = AXES[width], n = cross(u, v);
    const along = (axis: Vec3): number => Math.abs(axis[0] * extent[0] + axis[1] * extent[1] + axis[2] * extent[2]);
    const local = [0, 1, 2].map(i => (u[i]! + v[i]! + n[i]! < 0 ? hi[i]! : lo[i]!)) as unknown as Vec3;
    const rotated = this.place(local);
    const origin: Vec3 = this.face ? [rotated[0] + this.face.at[0], rotated[1] + this.face.at[1], rotated[2]] : local;
    this.parts.push({
      name, assembly, role, size: [along(u), along(v), along(n)],
      shape: options.rings ? { kind: 'lofted', rings: options.rings } : options.section ? { kind: 'section', outline: options.section } : { kind: 'stock', cuts: options.cuts ?? [] },
      origin, x: this.place(u), y: this.place(v), z: this.place(n), plusZRole: options.plusZRole, zeroFaceRole: options.zeroFaceRole,
    });
  }

  /** Add a round part, such as a knob, standing out of this builder's space toward -y from `back`. */
  addRound(name: string, assembly: string | null, role: string, centerX: number, centerZ: number, back: number, length: number, radius: number, segments = 24): void {
    const outline: Pt[] = Array.from({ length: segments }, (_, i) => {
      const a = (2 * Math.PI * i) / segments;
      return [radius + radius * Math.cos(a), radius + radius * Math.sin(a)] as const;
    });
    const local: Vec3 = [centerX - radius, back, centerZ - radius];
    const rotated = this.place(local);
    const origin: Vec3 = this.face ? [rotated[0] + this.face.at[0], rotated[1] + this.face.at[1], rotated[2]] : local;
    this.parts.push({ name, assembly, role, size: [2 * radius, 2 * radius, length], shape: { kind: 'prism', outline, round: true }, origin, x: this.place(AXES['+x']), y: this.place(AXES['+z']), z: this.place(AXES['-y']) });
  }

  /** Add a flat part with a counter-clockwise outline given in the plan's coordinates, and optional clockwise holes through it. */
  addOutline(name: string, role: string, outline: readonly Pt[], z: Range, round = false, holes: readonly (readonly Pt[])[] = []): void {
    const minX = Math.min(...outline.map(p => p[0])), minY = Math.min(...outline.map(p => p[1]));
    const shift = (ring: readonly Pt[]): Pt[] => ring.map(([x, y]) => [x - minX, y - minY] as const);
    const local = shift(outline);
    const size: Vec3 = [Math.max(...local.map(p => p[0])), Math.max(...local.map(p => p[1])), span(z)];
    this.parts.push({ name, assembly: null, role, size, shape: { kind: 'prism', outline: local, round, ...(holes.length ? { holes: holes.map(shift) } : {}) }, origin: [minX, minY, z.from], x: AXES['+x'], y: AXES['+y'], z: AXES['+z'] });
  }
}
