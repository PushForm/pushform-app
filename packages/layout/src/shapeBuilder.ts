// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutEntity } from './LayoutDocument';
import type { LayoutRectanglePath } from './rectangles';
import { mergeLayoutShapeRegions, type LayoutShapeRegion } from './booleans';
import { layoutEntityBounds } from './selection';

export interface LayoutShapeBuildGesture {
  mode: 'add' | 'remove';
  regions: string[];
}
export interface LayoutShapeBuildResult {
  groups: { regions: string[]; shape: LayoutRectanglePath; sourceIndex: number }[];
  selected: string[];
  removed: string[];
  sourceIndex: number | null;
}

/** Retain each original's own coverage and style without resurrecting excluded cells. */
export function retainedLayoutShapeSources(regions: readonly LayoutShapeRegion[], kept: ReadonlySet<string>) {
  const sourceIndices = [...new Set(regions.flatMap(region => region.sourceIndices))].sort((a, b) => a - b);
  return sourceIndices.flatMap(sourceIndex => {
    const cells = regions.filter(region => kept.has(region.key) && region.sourceIndices.includes(sourceIndex));
    return cells.length ? [{ sourceIndex, regions: cells.map(cell => cell.key), shape: mergeLayoutShapeRegions(cells) }] : [];
  });
}

export const layoutShapeBuildSnapshot = (sources: readonly LayoutEntity[]): string => JSON.stringify(sources);

/** Replay immutable region choices. The first Add supplies one style for the session. */
export function replayLayoutShapeBuild(
  regions: readonly LayoutShapeRegion[], gestures: readonly LayoutShapeBuildGesture[],
): LayoutShapeBuildResult {
  const byKey = new Map(regions.map(region => [region.key, region]));
  let groups: string[][] = [];
  const removed = new Set<string>();
  let sourceIndex: number | null = null;
  const components = (keys: readonly string[]): string[][] => {
    const remaining = new Set(keys), result: string[][] = [];
    while (remaining.size) {
      const queue = [remaining.values().next().value!];
      remaining.delete(queue[0]!);
      for (let i = 0; i < queue.length; i++) for (const neighbor of byKey.get(queue[i]!)!.neighbors) {
        if (remaining.delete(neighbor)) queue.push(neighbor);
      }
      result.push(queue);
    }
    return result;
  };
  for (const gesture of gestures) {
    const touched = [...new Set(gesture.regions)];
    if (touched.some(key => !byKey.has(key))) throw new Error('Shape Builder regions have changed. Start again.');
    if (!touched.length) continue;
    if (gesture.mode === 'remove') {
      touched.forEach(key => removed.add(key));
      groups = groups.flatMap(group => components(group.filter(key => !removed.has(key))).sort((a, b) => {
        const bounds = (keys: string[]) => layoutEntityBounds({ id: 0, layerId: 0, kind: 'path',
          ...mergeLayoutShapeRegions(keys.map(key => byKey.get(key)!)) })!;
        const left = bounds(a), right = bounds(b);
        return left.minX - right.minX || left.minY - right.minY;
      }));
    } else {
      if (groups.some(group => touched.every(key => group.includes(key)))) continue;
      sourceIndex ??= byKey.get(touched[0]!)!.sourceIndex;
      touched.forEach(key => removed.delete(key));
      const joining = groups.filter(group => group.some(key => touched.includes(key) ||
        byKey.get(key)!.neighbors.some(neighbor => touched.includes(neighbor))));
      const joined = components([...new Set([...touched, ...joining.flat()])]);
      const index = groups.findIndex(group => joining.includes(group));
      const next = groups.filter(group => !joining.includes(group));
      next.splice(index < 0 ? next.length : index, 0, ...joined);
      groups = next;
    }
  }
  const selected = groups.flat();
  return {
    groups: sourceIndex === null
      ? removed.size ? retainedLayoutShapeSources(regions, new Set(regions.filter(region => !removed.has(region.key)).map(region => region.key))) : []
      : groups.map(keys => ({ regions: keys, shape: mergeLayoutShapeRegions(keys.map(key => byKey.get(key)!)), sourceIndex })),
    selected,
    removed: [...removed], sourceIndex,
  };
}
