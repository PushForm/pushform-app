// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import clipping from 'polygon-clipping';
import type { MultiPolygon } from 'polygon-clipping';
import { AREA_TOL, LENGTH_TOL, RATIO_TOL } from '@pushform/core';
import {
  planarArrangement,
  type ArrangementEdgeRef,
  type ArrangementSegment,
} from '@pushform/geom';
import paper from 'paper/dist/paper-core';
import type { LayoutEntity, LayoutPathHandle } from './LayoutDocument';
import type { LayoutRectanglePath } from './rectangles';
import { layoutPathContours, validLayoutContourStarts } from './path';

export const LAYOUT_BOOLEAN_OPERATIONS = ['union', 'subtract', 'intersect', 'exclude'] as const;
export type LayoutBooleanOperation = (typeof LAYOUT_BOOLEAN_OPERATIONS)[number];
export const LAYOUT_PATH_OPERATIONS = [
  ...LAYOUT_BOOLEAN_OPERATIONS,
  'division',
  'cut-path',
] as const;
export type LayoutPathOperation = (typeof LAYOUT_PATH_OPERATIONS)[number];
const PAPER_LENGTH_TOL = LENGTH_TOL * 1000;
const PAPER_AREA_TOL = AREA_TOL * 1000 * 1000;
type Source = Pick<
  LayoutEntity,
  'kind' | 'points' | 'handles' | 'closed' | 'contourStarts' | 'openContours'
>;
type Point = [number, number];
const xy = (p: paper.Point): Point => [p.x, p.y];

// A private, lazily initialized geometry workspace. No document entities or previews
// are inserted into its scene graph, and no PaperScript or canvas drawing is used.
let geometryScope: paper.PaperScope | undefined;
function scope(): paper.PaperScope {
  if (!geometryScope) {
    geometryScope = new paper.PaperScope();
    geometryScope.setup(new paper.Size(1, 1));
    geometryScope.view.autoUpdate = false;
    geometryScope.settings.insertItems = false;
  }
  geometryScope.activate();
  return geometryScope;
}

function outlines(source: Source): paper.Path[] {
  const engine = scope();
  if (source.kind !== 'path') throw new Error('Choose a native path.');
  if (
    (source.handles && source.handles.length !== source.points.length) ||
    (source.contourStarts &&
      !validLayoutContourStarts(
        source.points,
        source.closed,
        source.contourStarts,
        source.openContours,
      )) ||
    !source.points.every((p) => p.every(Number.isFinite)) ||
    source.handles?.some((h) => [h.in, h.out].some((p) => p && !p.every(Number.isFinite)))
  )
    throw new Error('Invalid path contours or curve handles.');
  return layoutPathContours(
    source.points,
    source.handles,
    source.closed,
    source.contourStarts,
    source.openContours,
  ).map((contour) => {
    const path = new engine.Path({
      insert: false,
      closed: contour.closed,
      segments: contour.points.map((p, i) => {
        const h = contour.handles?.[i];
        return new engine.Segment(
          p,
          h?.in ? [h.in[0] - p[0], h.in[1] - p[1]] : undefined,
          h?.out ? [h.out[0] - p[0], h.out[1] - p[1]] : undefined,
        );
      }),
    });
    if (path.length <= PAPER_LENGTH_TOL) throw new Error('Choose a non-degenerate path.');
    return path;
  });
}

/** Native cubic regions, normalized to the document's even-odd fill rule. */
function region(source: Source): paper.PathItem {
  if (!source.closed || source.openContours?.length)
    throw new Error('Boolean operations require closed paths.');
  const paths = outlines(source);
  for (const path of paths) {
    if (Math.abs(path.area) <= PAPER_AREA_TOL || path.getIntersections().length)
      throw new Error('Boolean operations require non-degenerate, non-self-intersecting contours.');
  }
  const result = paths
    .slice(1)
    .reduce<paper.PathItem>((a, b) => a.exclude(b, { insert: false }), paths[0]!);
  if (!result || result.isEmpty()) throw new Error('Boolean operands must enclose an area.');
  return result;
}

export function validateLayoutPathOperand(
  source: Source,
  operation: LayoutPathOperation,
  target: boolean,
): void {
  if (operation === 'cut-path' || (operation === 'division' && !target)) outlines(source);
  else region(source);
}

/** Copy exact cubic portions into native anchors/absolute handles, never sampled vertices. */
function fromCurves(input: readonly paper.Curve[], closed: boolean): LayoutRectanglePath {
  const curves = [...input];
  // Native closed contours require at least three anchors (including compound holes).
  // A two-arc lens needs one exact subdivision to meet that representation contract.
  while (closed && curves.length > 0 && curves.length < 3) {
    const index = curves.reduce((best, c, i) => (c.length > curves[best]!.length ? i : best), 0);
    const curve = curves[index]!;
    curves.splice(index, 1, curve.getPart(0, 0.5), curve.getPart(0.5, 1));
  }
  const points = curves.map((c) => xy(c.point1));
  if (!closed && curves.length) points.push(xy(curves.at(-1)!.point2));
  const handles: LayoutPathHandle[] = points.map(() => ({}));
  curves.forEach((c, i) => {
    if (c.isStraight()) return;
    if (!c.handle1.isZero()) handles[i]!.out = xy(c.point1.add(c.handle1));
    if (!c.handle2.isZero()) handles[(i + 1) % points.length]!.in = xy(c.point2.add(c.handle2));
  });
  return { points, closed, ...(handles.some((h) => h.in || h.out) ? { handles } : {}) };
}

function combine(contours: LayoutRectanglePath[]): LayoutRectanglePath | null {
  if (!contours.length) return null;
  const points: Point[] = [],
    handles: LayoutPathHandle[] = [],
    contourStarts: number[] = [];
  for (const contour of contours) {
    contourStarts.push(points.length);
    points.push(...contour.points);
    handles.push(...contour.points.map((_, i) => contour.handles?.[i] ?? {}));
  }
  return {
    points,
    closed: true,
    ...(contourStarts.length > 1 ? { contourStarts } : {}),
    ...(handles.some((h) => h.in || h.out) ? { handles } : {}),
  };
}

function fromRegion(result: paper.PathItem): LayoutRectanglePath | null {
  const paths = result instanceof paper.Path ? [result] : (result.children as paper.Path[]);
  return combine(
    paths.filter((p) => Math.abs(p.area) > PAPER_AREA_TOL).map((p) => fromCurves(p.curves, true)),
  );
}

/** Pure paper-space operation. Sources remain immutable; only intersection nodes are added. */
export function booleanLayoutPaths(
  sources: readonly Source[],
  operation: LayoutBooleanOperation,
): LayoutRectanglePath | null {
  if (sources.length < 2) throw new Error('Choose at least two closed paths.');
  const regions = sources.map(region);
  const method = {
    union: 'unite',
    subtract: 'subtract',
    intersect: 'intersect',
    exclude: 'exclude',
  } as const;
  return fromRegion(
    regions.slice(1).reduce((a, b) => a[method[operation]](b, { insert: false }), regions[0]!),
  );
}

/** Ordered curve-time cuts, including overlap endpoints, independent of tessellation. */
function cutsOn(path: paper.Path, cutters: readonly paper.Path[]): number[] {
  const count = path.curves.length;
  return cutters
    .flatMap((cutter) =>
      path
        .getIntersections(cutter)
        .flatMap((hit) => (cutter === path && hit.intersection ? [hit, hit.intersection] : [hit]))
        .map((hit) => {
          let time = hit.index + hit.time;
          if (Math.abs(time - Math.round(time)) < RATIO_TOL) time = Math.round(time);
          return path.closed && time === count ? 0 : time;
        }),
    )
    .sort((a, b) => a - b)
    .filter(
      (t, i, all) =>
        (path.closed || (t > RATIO_TOL && t < count - RATIO_TOL)) &&
        (i === 0 || t - all[i - 1]! > RATIO_TOL),
    );
}

function portion(path: paper.Path, from: number, to: number): paper.Curve[] {
  const curves: paper.Curve[] = [],
    count = path.curves.length;
  for (let i = Math.floor(from); i < Math.ceil(to); i++) {
    const a = Math.max(0, from - i),
      b = Math.min(1, to - i);
    if (b - a > RATIO_TOL) curves.push(path.curves[i % count]!.getPart(a, b));
  }
  return curves;
}

function cutPaths(sources: readonly Source[]): LayoutRectanglePath[] {
  const target = outlines(sources[0]!),
    cutters = sources.slice(1).flatMap(outlines);
  return target.flatMap((path) => {
    const cuts = cutsOn(path, cutters),
      count = path.curves.length;
    if (!cuts.length) return [fromCurves(path.curves, path.closed)];
    const bounds = path.closed ? [...cuts, cuts[0]! + count] : [0, ...cuts, count];
    return bounds
      .slice(0, -1)
      .map((from, i) => fromCurves(portion(path, from, bounds[i + 1]!), false));
  });
}

/** Division uses a planar arrangement only for connectivity. Every temporary edge
 * retains its original curve and parameter interval, so output is reconstructed
 * from exact source spans, not the polygonal approximation used by the graph. */
function arrangePaths(paths: readonly paper.Path[]) {
  const segments: ArrangementSegment[] = [];
  const spans: { curve: paper.Curve; from: number; to: number; pathIndex: number }[] = [];
  const targetRings: Point[][] = [];
  paths.forEach((path, pathIndex) => {
    const cuts = [0, ...cutsOn(path, paths), path.curves.length];
    const ring: Point[] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      for (const curve of portion(path, cuts[i]!, cuts[i + 1]!)) {
        const samples: { point: Point; time: number }[] = [{ point: xy(curve.point1), time: 0 }];
        const sample = (from: number, to: number, depth: number): void => {
          const part = curve.getPart(from, to);
          const chord = part.point1.getDistance(part.point2);
          const hull =
            part.point1.getDistance(part.point1.add(part.handle1)) +
            part.point1.add(part.handle1).getDistance(part.point2.add(part.handle2)) +
            part.handle2.length;
          const delta = part.point2.subtract(part.point1);
          const flatness = chord
            ? Math.max(Math.abs(delta.cross(part.handle1)), Math.abs(delta.cross(part.handle2))) /
              chord
            : hull;
          // Samples determine connectivity only; retain curve-time provenance.
          if (depth < 16 && Math.max(flatness, hull - chord) > PAPER_LENGTH_TOL / 4) {
            const middle = (from + to) / 2;
            sample(from, middle, depth + 1);
            sample(middle, to, depth + 1);
          } else samples.push({ point: xy(part.point2), time: to });
        };
        sample(0, 1, 0);
        ring.push(...samples.slice(0, -1).map((s) => s.point));
        for (let j = 0; j < samples.length - 1; j++) {
          const a = samples[j]!,
            b = samples[j + 1]!;
          segments.push({ id: spans.length, a: a.point, b: b.point });
          spans.push({ curve, from: a.time, to: b.time, pathIndex });
        }
      }
    }
    targetRings.push(ring);
  });
  const arrangement = planarArrangement(segments, {
    tol: PAPER_LENGTH_TOL,
    areaTol: PAPER_AREA_TOL,
  });
  const restore = (refs: ArrangementEdgeRef[]): LayoutRectanglePath => {
    const runs: { curve: paper.Curve; from: number; to: number }[] = [];
    for (const ref of refs) {
      const edge = arrangement.edges[ref.edge]!,
        provenance = edge.segs[0]!;
      const span = spans[provenance.id]!;
      const forward = ref.forward === provenance.forward;
      const a = arrangement.vertices[ref.forward ? edge.a : edge.b]!;
      const b = arrangement.vertices[ref.forward ? edge.b : edge.a]!;
      // Snapped endpoints map to the exact stored parameters. A shortened edge
      // (e.g. collinear overlap) is projected back onto its original curve.
      const timeAt = (p: Point, t: number): number =>
        span.curve.getPointAtTime(t).getDistance(p) <= PAPER_LENGTH_TOL
          ? t
          : span.curve.getNearestLocation(p).time;
      const from = timeAt(a, forward ? span.from : span.to),
        to = timeAt(b, forward ? span.to : span.from);
      const last = runs.at(-1);
      if (last?.curve === span.curve && Math.abs(last.to - from) <= RATIO_TOL) last.to = to;
      else runs.push({ curve: span.curve, from, to });
    }
    // A cell's arbitrary starting edge can fall inside a sampled curve span.
    const first = runs[0],
      last = runs.at(-1);
    if (
      runs.length > 1 &&
      first &&
      last &&
      first.curve === last.curve &&
      Math.abs(last.to - first.from) <= RATIO_TOL
    ) {
      first.from = last.from;
      runs.pop();
    }
    return fromCurves(
      runs.map((r) => r.curve.getPart(r.from, r.to)),
      true,
    );
  };
  return { arrangement, restore, rings: targetRings,
    pathIndices: (refs: ArrangementEdgeRef[]) => [...new Set(refs.flatMap(ref =>
      arrangement.edges[ref.edge]!.segs.map(segment => spans[segment.id]!.pathIndex)))],
  };
}

function dividePaths(sources: readonly Source[]): LayoutRectanglePath[] {
  const target = region(sources[0]!);
  const boundary = target instanceof paper.Path ? [target] : (target.children as paper.Path[]);
  const { arrangement, restore, rings } = arrangePaths([...boundary, ...sources.slice(1).flatMap(outlines)]);
  const targetRings = rings.slice(0, boundary.length);
  const pieces: LayoutRectanglePath[] = [];
  const targetPolygons = targetRings.reduce<MultiPolygon>(
    (area, ring) => clipping.xor(area, [[ring]]),
    [],
  );
  for (const cell of arrangement.cells) {
    // The arrangement already includes every target boundary. Use the sampled
    // regions only to classify complete cells; never export clipping vertices.
    const inside = clipping.intersection([cell.outer, ...cell.holes], targetPolygons);
    if (!inside.length) continue;
    const shape = combine([restore(cell.outerEdges), ...cell.holeEdges.map(restore)]);
    if (shape) pieces.push(shape);
  }
  if (!pieces.length)
    throw new Error('The target is too small to divide at the geometry tolerance.');
  return pieces;
}

export function operateLayoutPaths(
  sources: readonly Source[],
  operation: LayoutPathOperation,
): LayoutRectanglePath[] {
  if (sources.length < 2) throw new Error('Choose a target and at least one cutter.');
  if (operation === 'division') return dividePaths(sources);
  if (operation === 'cut-path') return cutPaths(sources);
  const result = booleanLayoutPaths(sources, operation);
  return result ? [result] : [];
}

export interface LayoutShapeRegion {
  key: string;
  shape: LayoutRectanglePath;
  sourceIndex: number;
  sourceIndices: number[];
  neighbors: string[];
}

function evenOddRegion(source: Source): paper.PathItem {
  if (!source.closed || source.openContours?.length) throw new Error('Shape Builder requires closed paths.');
  const engine = scope();
  const result = new engine.CompoundPath({ children: outlines(source), insert: false });
  result.fillRule = 'evenodd';
  return result;
}

/** A point strictly inside a sampled cell, including concave cells with holes. */
function interiorPoint(rings: Point[][]): Point {
  const ys = [...new Set(rings.flat().map(p => p[1]))].sort((a, b) => a - b);
  let best: Point | null = null, width = PAPER_LENGTH_TOL;
  for (let yIndex = 1; yIndex < ys.length; yIndex++) {
    const y = (ys[yIndex - 1]! + ys[yIndex]!) / 2;
    const xs: number[] = [];
    for (const ring of rings) for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i < xs.length - 1; i += 2) {
      if (xs[i + 1]! - xs[i]! > width) { width = xs[i + 1]! - xs[i]!; best = [(xs[i]! + xs[i + 1]!) / 2, y]; }
    }
  }
  if (!best) throw new Error('A Shape Builder region is too small at the geometry tolerance.');
  return best;
}

/** Partition the entire selection, preserving the native curve spans of every cell. */
export function createLayoutShapeRegions(sources: readonly Source[]): LayoutShapeRegion[] {
  if (!sources.length) throw new Error('Select lines or shapes before using Shape Builder.');
  const engine = scope();
  const sourcePaths = sources.map(outlines);
  // Open contours contribute boundaries, never an implicit closing edge or fill.
  const coverage = sourcePaths.map(paths => {
    const area = new engine.CompoundPath({ children: paths.filter(path => path.closed), insert: false });
    area.fillRule = 'evenodd';
    return area;
  });
  const paths = sourcePaths.flat();
  const owners = sourcePaths.flatMap((paths, index) => paths.map(() => index));
  const { arrangement, restore, pathIndices } = arrangePaths(paths);
  const cells = arrangement.cells.flatMap((cell, index) => {
    const shape = combine([restore(cell.outerEdges), ...cell.holeEdges.map(restore)])!;
    // Choose a point well inside the cell; coverage uses original source curves.
    const p = interiorPoint([cell.outer, ...cell.holes]);
    const sourceIndices = coverage.flatMap((area, i) => area.contains(new paper.Point(p)) ? [i] : []);
    // With no filled source, a bounded cell can still be enclosed by selected
    // lines (alone or together with shape edges). Use its frontmost open boundary.
    if (!sourceIndices.length) {
      const donors = pathIndices(cell.outerEdges).filter(index => !paths[index]!.closed).map(index => owners[index]!);
      if (!donors.length) return [];
      sourceIndices.push(Math.max(...donors));
    }
    const sourceIndex = sourceIndices.at(-1)!;
    return [{ key: `region-${index}`, shape, sourceIndex, sourceIndices, neighbors: [] as string[],
      edges: new Set([...cell.outerEdges, ...cell.holeEdges.flat()].map(ref => ref.edge)) }];
  });
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const a = cells[i]!, b = cells[j]!;
    if ([...a.edges].some(edge => b.edges.has(edge))) { a.neighbors.push(b.key); b.neighbors.push(a.key); }
  }
  if (!cells.length) throw new Error('Selected paths do not enclose usable regions.');
  return cells.map(({ edges: _edges, ...cell }) => cell);
}

/** Exact cubic hit/segment testing; intermediate pointer events cannot skip cells. */
export function layoutShapeRegionsAlong(regions: readonly LayoutShapeRegion[], from: Point, to: Point): string[] {
  const engine = scope();
  const line = new engine.Path.Line({ from, to, insert: false });
  const length = line.length;
  const hits: { key: string; time: number }[] = [];
  for (const cell of regions) {
    const area = evenOddRegion({ kind: 'path', ...cell.shape });
    const inside = (point: paper.Point): boolean => area.contains(point) &&
      outlines({ kind: 'path', ...cell.shape }).every(path => path.getNearestPoint(point).getDistance(point) > PAPER_LENGTH_TOL);
    if (length <= PAPER_LENGTH_TOL) {
      if (inside(new engine.Point(from))) hits.push({ key: cell.key, time: 0 });
      continue;
    }
    const times = [0, ...line.getIntersections(area).map(hit => hit.offset / length), 1].sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      const time = (times[i - 1]! + times[i]!) / 2;
      if (inside(line.getPointAt(time * length))) { hits.push({ key: cell.key, time }); break; }
    }
  }
  return hits.sort((a, b) => a.time - b.time).map(hit => hit.key);
}

/** Clip originals containing open contours to the kept area without closing their lines. */
export function retainLayoutShapeOpenSource(source: Source, regions: readonly LayoutShapeRegion[]): {
  unchanged: boolean; shapes: LayoutRectanglePath[];
} {
  if (!regions.length) return { unchanged: false, shapes: [] };
  const kept = mergeLayoutShapeRegions(regions);
  const area = evenOddRegion({ kind: 'path', ...kept });
  const boundaries = outlines({ kind: 'path', ...kept });
  const paths = outlines(source), shapes: LayoutRectanglePath[] = [];
  let unchanged = true;
  const closed = paths.filter(path => path.closed);
  if (closed.length) {
    const original = new (scope().CompoundPath)({ children: closed, insert: false });
    original.fillRule = 'evenodd';
    const retained = fromRegion(original.intersect(area, { insert: false }));
    if (retained) shapes.push(retained);
    if (fromRegion(original.subtract(area, { insert: false }))) unchanged = false;
  }
  for (const path of paths.filter(path => !path.closed)) {
    const cuts = [0, ...cutsOn(path, boundaries), path.curves.length];
    let run: paper.Curve[] = [];
    for (let i = 1; i < cuts.length; i++) {
      const curves = portion(path, cuts[i - 1]!, cuts[i]!);
      const point = curves[0]!.getPointAtTime(0.5);
      if (area.contains(point) || boundaries.some(boundary => boundary.getNearestPoint(point).getDistance(point) <= PAPER_LENGTH_TOL)) {
        run.push(...curves);
      } else {
        unchanged = false;
        if (run.length) shapes.push(fromCurves(run, false));
        run = [];
      }
    }
    if (run.length) shapes.push(fromCurves(run, false));
  }
  return { unchanged, shapes };
}

/** Region groups are connected by shared edges before this union is requested. */
export function mergeLayoutShapeRegions(regions: readonly LayoutShapeRegion[]): LayoutRectanglePath {
  const paths = regions.map(cell => evenOddRegion({ kind: 'path', ...cell.shape }));
  const merged = paths.slice(1).reduce((a, b) => a.unite(b, { insert: false }), paths[0]!);
  const shape = fromRegion(merged);
  if (!shape) throw new Error('Cannot build an empty region group.');
  return shape;
}
