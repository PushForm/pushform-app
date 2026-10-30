// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL, v3dot, v3len, v3normalize, v3sub } from '@pushform/core';
import type { Plane, Vec3 } from '@pushform/core';
import { perpendicularTo, SNAP_COLORS } from '@pushform/inference';
import type { InferenceResult, Snap } from '@pushform/inference';
import type { EntityRef } from '@pushform/model';

/** An edge inference has shown: its direction, a point on its line when known, and the edge. */
interface InferredEdge {
  readonly dir: Vec3;
  readonly point: Vec3 | null;
  readonly ref: EntityRef | undefined;
}

/** Snaps that name an edge's direction: points on it, its midpoint, its extension, and Parallel to Edge. */
const EDGE_SNAPS: ReadonlySet<Snap['kind']> = new Set(['onEdge', 'midpoint', 'extension', 'parallel']);

/**
 * The Down-arrow lock (Down arrow): remembers the last edge inference showed and locks the direction from a
 * start point parallel or perpendicular to it, whichever is closer to the direction toward the cursor.
 */
export class EdgeLock {
  private edge: InferredEdge | null = null;
  private locked: { kind: 'parallel' | 'perpendicular'; dir: Vec3; ref: EntityRef | undefined } | null = null;

  /** Note the edge an inference shows. Ignored while locked, since the lock's own snap is not an inferred edge. */
  observe(inf: InferenceResult | null): void {
    if (!inf || this.locked) return;
    for (const s of [inf.primary, ...inf.secondary]) {
      if (!EDGE_SNAPS.has(s.kind) || !s.dir || v3len(s.dir) < LENGTH_TOL) continue;
      this.edge = { dir: v3normalize(s.dir), point: s.kind === 'parallel' ? null : s.point, ref: s.ref };
      return;
    }
  }

  get active(): boolean {
    return this.locked !== null;
  }

  /** The locked direction, or null. */
  get direction(): Vec3 | null {
    return this.locked?.dir ?? null;
  }

  /**
   * Down arrow: release the lock when held, else lock to the remembered edge from `anchor`. Returns false when there is
   * nothing to lock to (no anchor or no inferred edge), so the caller can treat the key as releasing its arrow lock.
   */
  toggle(anchor: Vec3 | null, cursor: Vec3 | null, plane: Plane): boolean {
    if (this.locked) { this.locked = null; return true; }
    const edge = this.edge;
    if (!anchor || !edge) return false;
    const parallel = edge.dir;
    // Without a point on the edge's line (Parallel to Edge), treat the anchor as on it: square to the edge in the plane.
    const perpendicular = perpendicularTo({ a: edge.point ?? anchor, dir: edge.dir }, anchor, plane);
    const toward = cursor && v3len(v3sub(cursor, anchor)) > LENGTH_TOL ? v3normalize(v3sub(cursor, anchor)) : null;
    const usePerpendicular = toward !== null && Math.abs(v3dot(toward, perpendicular)) > Math.abs(v3dot(toward, parallel));
    const dir = usePerpendicular ? perpendicular : parallel;
    // Pointing toward the cursor, so a typed length goes the way the pointer does.
    const facing: Vec3 = toward && v3dot(toward, dir) < 0 ? [0 - dir[0], 0 - dir[1], 0 - dir[2]] : dir;
    this.locked = { kind: usePerpendicular ? 'perpendicular' : 'parallel', dir: facing, ref: edge.ref };
    return true;
  }

  release(): void {
    this.locked = null;
  }

  /** Forget the remembered edge and the lock (the tool was reset). */
  clear(): void {
    this.locked = null;
    this.edge = null;
  }

  /** The lock as an inference constraint through `anchor` (drawn magenta, named in the tooltip). */
  snapAt(anchor: Vec3 | null): Snap | null {
    const l = this.locked;
    if (!l || !anchor) return null;
    return l.kind === 'parallel'
      ? { kind: 'parallel', point: anchor, dir: l.dir, ref: l.ref, color: SNAP_COLORS.parallel, label: 'Parallel to Edge' }
      : { kind: 'perpendicular', point: anchor, dir: l.dir, ref: l.ref, color: SNAP_COLORS.perpendicular, label: 'Perpendicular to Edge' };
  }
}
