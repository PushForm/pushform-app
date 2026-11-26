// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';

/**
 * Reduces a closed loop to at most `max` points by Visvalingam–Whyatt: the point whose removal changes the enclosed
 * area least (the smallest triangle with its two neighbours) goes first, and areas are recomputed as neighbours
 * change. A loop of `max` points or fewer comes back as it is. Collinear points go first, so a loop with many
 * segments along straight runs keeps every corner.
 */
export function simplifyLoop(loop: readonly Vec3[], max: number): readonly Vec3[] {
  const n = loop.length;
  if (n <= max || max < 3) return loop;
  const prev = Array.from({ length: n }, (_, i) => (i + n - 1) % n);
  const next = Array.from({ length: n }, (_, i) => (i + 1) % n);
  const removed = new Array<boolean>(n).fill(false);
  const version = new Array<number>(n).fill(0);
  const area = (i: number): number => triangleArea(loop[prev[i]!]!, loop[i]!, loop[next[i]!]!);
  // A binary heap of (area, point, version); an entry whose version is stale is skipped when it surfaces.
  const heap: { area: number; i: number; v: number }[] = [];
  const push = (i: number): void => { const entry = { area: area(i), i, v: version[i]! }; heap.push(entry); up(heap, heap.length - 1); };
  const pop = (): { area: number; i: number; v: number } | undefined => {
    const top = heap[0], last = heap.pop();
    if (last !== undefined && heap.length > 0) { heap[0] = last; down(heap, 0); }
    return top;
  };
  for (let i = 0; i < n; i++) push(i);
  let remaining = n;
  while (remaining > max) {
    const entry = pop();
    if (!entry) break;
    const i = entry.i;
    if (removed[i] || entry.v !== version[i]) continue;
    removed[i] = true;
    remaining--;
    const p = prev[i]!, q = next[i]!;
    next[p] = q; prev[q] = p;
    version[p]!++; version[q]!++;
    push(p); push(q);
  }
  return loop.filter((_, i) => !removed[i]);
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

function up(heap: { area: number }[], index: number): void {
  for (let i = index; i > 0;) {
    const parent = (i - 1) >> 1;
    if (heap[parent]!.area <= heap[i]!.area) return;
    [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
    i = parent;
  }
}

function down(heap: { area: number }[], index: number): void {
  for (let i = index;;) {
    const left = 2 * i + 1, right = left + 1;
    let least = i;
    if (left < heap.length && heap[left]!.area < heap[least]!.area) least = left;
    if (right < heap.length && heap[right]!.area < heap[least]!.area) least = right;
    if (least === i) return;
    [heap[least], heap[i]] = [heap[i]!, heap[least]!];
    i = least;
  }
}
