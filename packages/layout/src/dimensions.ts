// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ROUNDING_TIE_TOL, RATIO_TOL, type LengthFormat } from '@pushform/core';
import { LAYOUT_DEFAULT_TEXT } from './text';
import { angularRaysFromPoints, resolveAngularEdgePoints } from './angularEdges';
import { layoutAnchorOnPath, layoutPathAnchorAt, SEGMENT_ANCHOR_TOL_MM } from './anchors';
import { isLayoutLayerVisible, entityOnPage, type LayoutDocumentState, type LayoutEntity, type LayoutPage, type LayoutLinearDimension, type LayoutDimensionAnchor, type LayoutAngularDimension } from './LayoutDocument';
type Point = [number, number];

export function createLinearDimension(): LayoutLinearDimension {
  return { anchors: [null, null], alignment: 'aligned', units: 'mm', precision: 1, showUnits: true,
    text: '<>', fontFamily: LAYOUT_DEFAULT_TEXT.fontFamily, fontSizePt: LAYOUT_DEFAULT_TEXT.fontSizePt, endpoint: 'arrow', arrowSizeMm: 2.5,
    extensionGapMm: 1, extensionOverrunMm: 2, cachedValueMm: 0, detached: false };
}

/** A small angular capture range keeps interactive dimensions square without moving their measured points. */
export function inferLinearDimensionAlignment(a: Point, b: Point): LayoutLinearDimension['alignment'] {
  const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
  if (![dx, dy].every(Number.isFinite) || Math.hypot(dx, dy) < 1e-6) return 'aligned';
  const angle = Math.atan2(dy, dx), tolerance = 3 * Math.PI / 180;
  if (angle <= tolerance) return 'horizontal';
  if (Math.PI / 2 - angle <= tolerance) return 'vertical';
  return 'aligned';
}

export function linearMeasurement(a: Point, b: Point, alignment: LayoutLinearDimension['alignment'], angleDeg = 0): number {
  if (alignment === 'rotated') {
    // The separation along the dimension line's own direction.
    const radians = angleDeg * Math.PI / 180;
    return Math.abs((b[0] - a[0]) * Math.cos(radians) + (b[1] - a[1]) * Math.sin(radians));
  }
  return alignment === 'horizontal' ? Math.abs(b[0] - a[0])
    : alignment === 'vertical' ? Math.abs(b[1] - a[1]) : Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** A dimension line direction as an angle in [0, 180): a line has no head, so 190° is the same line as 10°. */
export function normalizeDimensionAngle(angleDeg: number): number {
  const normalized = ((angleDeg % 180) + 180) % 180;
  return Math.abs(normalized - 180) < 1e-9 ? 0 : normalized;
}

type SourceLookup = (id: number) => LayoutEntity | undefined;

/** Measured points and value from the looked-up source geometry, or null when an association cannot be resolved. */
export function resolveLayoutDimension(entity: LayoutEntity, lookup: SourceLookup): { points: Point[]; value: number } | null {
  // Model measurements are refreshed from model identities, never from their projected paper length.
  if (entity.modelAnnotation) return null;
  const dim = entity.dimension ?? entity.angularDimension;
  if (!dim) return null;
  let resolved: (Point | undefined)[];
  if (entity.angularDimension?.rayDefinition) {
    const rays = entity.angularDimension.rayDefinition;
    const points = rays.points.map((point, index) => {
      const anchor = rays.anchors[index];
      if (!anchor) return point;
      const source = lookup(anchor.entityId);
      return source ? layoutAnchorOnPath(source, anchor) : undefined;
    });
    if (points.some(point => !point)) return null;
    try { resolved = angularRaysFromPoints(points as Point[]); } catch { return null; }
  } else if (entity.angularDimension?.edgeAnchors) {
    try { resolved = resolveAngularEdgePoints(entity.angularDimension.edgeAnchors, lookup); } catch { return null; }
  } else {
    resolved = dim.anchors.map((anchor, index) => {
      if (!anchor) return entity.points[index];
      const source = lookup(anchor.entityId);
      return source ? layoutAnchorOnPath(source, anchor) : undefined;
    });
  }
  if (resolved.some((point) => !point)) return null;
  const points = resolved.map((point) => [...point!] as Point);
  if (entity.angularDimension) {
    const angle = angularMeasurement(points[0]!, points[1]!, points[2]!, entity.angularDimension.reflex);
    return angle === null || Math.min(angle, 360 - angle) < 1e-6 ? null : { points, value: angle };
  }
  return { points, value: linearMeasurement(points[0]!, points[1]!, entity.dimension!.alignment, entity.dimension!.angleDeg) };
}

/** The dimension as it will read once the looked-up (for example, dragged) source geometry commits; unchanged when unresolvable. */
export function previewLayoutDimension(entity: LayoutEntity, lookup: SourceLookup): LayoutEntity {
  const resolved = resolveLayoutDimension(entity, lookup);
  if (!resolved) return entity;
  const points = entity.points.map((point, index) => resolved.points[index] ?? point);
  return entity.dimension
    ? { ...entity, points, dimension: { ...entity.dimension, cachedValueMm: resolved.value, detached: false } }
    : { ...entity, points, angularDimension: { ...entity.angularDimension!, cachedAngleDeg: resolved.value, detached: false } };
}

/** Refresh cached endpoints and values in the same transaction as the source edit. */
export function refreshLayoutDimensions(state: LayoutDocumentState): void {
  const update = (entity: LayoutEntity, page: LayoutPage, shared: boolean): void => {
    const dim = entity.dimension ?? entity.angularDimension;
    if (!dim || entity.modelAnnotation) return;
    const resolved = resolveLayoutDimension(entity, (id) => shared ? state.sharedEntities.get(id) : entityOnPage(page, state, id));
    dim.detached = !resolved;
    if (!resolved) return;
    resolved.points.forEach((point, index) => {
      if (entity.points[index]![0] !== point[0] || entity.points[index]![1] !== point[1]) entity.points[index] = point;
    });
    if (entity.dimension) entity.dimension.cachedValueMm = resolved.value;
    if (entity.angularDimension) entity.angularDimension.cachedAngleDeg = resolved.value;
  };
  for (const page of state.pages.values()) for (const entity of page.entities.values()) update(entity, page, false);
  const firstPage = state.pages.get(state.pageOrder[0]!);
  if (firstPage) for (const entity of state.sharedEntities.values()) update(entity, firstPage, true);
}

/**
 * A measured point on a visible path attaches to it: to a vertex of any path first, otherwise to
 * the topmost path segment it lies on. Free paper points remain valid independent anchors.
 */
export function dimensionAnchorAt(point: Point, page: LayoutPage, state: LayoutDocumentState): LayoutDimensionAnchor | null {
  const paths: LayoutEntity[] = [];
  for (const layerId of [...state.layerOrder].reverse()) {
    if (!isLayoutLayerVisible(page, state, layerId)) continue;
    const shared = state.layers.get(layerId)?.shared;
    const entities = shared ? state.sharedEntities : page.entities;
    const order = shared ? state.sharedEntityOrder : page.entityOrder;
    for (const id of [...order].reverse()) {
      const entity = entities.get(id);
      if (entity?.kind === 'path' && entity.layerId === layerId && !entity.hidden) paths.push(entity);
    }
  }
  for (const entity of paths) {
    const index = entity.points.findIndex((p) => Math.hypot(p[0] - point[0], p[1] - point[1]) < SEGMENT_ANCHOR_TOL_MM);
    if (index >= 0) return { entityId: entity.id, pointIndex: index, pointCount: entity.points.length };
  }
  for (const entity of paths) {
    const anchor = layoutPathAnchorAt(entity, point);
    if (anchor) return anchor;
  }
  return null;
}

export function formatLinearDimension(dim: LayoutLinearDimension): string {
  return dim.text.replaceAll('<>', formatLayoutLength(dim.cachedValueMm / 25.4 / (dim.scale ?? 1), dim));
}

type LengthStyle = Pick<LayoutLinearDimension, 'units' | 'format' | 'precision' | 'showUnits' | 'showDashes'>;

/** Halves round up, even when converting stored millimeters left an exact half a hair below. */
const roundHalfUp = (steps: number): number => Math.floor(steps + 0.5 + ROUNDING_TIE_TOL);

/** Whole inches and a reduced fraction from a count of 1/denominator-inch steps: `11 1/2`, `1/2`, `12`. */
function fractionalInches(steps: number, denominator: number, joiner: string): string {
  const whole = Math.floor(steps / denominator);
  let numerator = steps - whole * denominator, reduced = denominator;
  while (numerator && numerator % 2 === 0) { numerator /= 2; reduced /= 2; }
  if (!numerator) return `${whole}`;
  return whole ? `${whole}${joiner}${numerator}/${reduced}` : `${numerator}/${reduced}`;
}

/** Inches to each decimal unit. */
const DECIMAL_UNITS: Record<LayoutLinearDimension['units'], [convert: (inches: number) => number, suffix: string]> = {
  mm: [inches => inches * 25.4, ' mm'], cm: [inches => inches * 2.54, ' cm'], m: [inches => inches * 0.0254, ' m'],
  inch: [inches => inches, '"'], ft: [inches => inches / 12, "'"], pt: [inches => inches * 72, ' pt'],
};

/**
 * A length, given in inches, in dimension notation:
 * `1250 mm`, `6'-3 1/2"`, `75-1/2"`, `6.29'`.
 */
export function formatLayoutLength(inches: number, style: LengthStyle): string {
  const format = style.format ?? 'decimal', precision = style.precision;
  const dash = style.showDashes === false ? ' ' : '-';
  if (format === 'architectural' || format === 'fractional') {
    const denominator = 2 ** precision, steps = roundHalfUp(inches * denominator);
    if (format === 'fractional') return `${fractionalInches(steps, denominator, dash)}${style.showUnits ? '"' : ''}`;
    const perFoot = 12 * denominator, feet = Math.floor(steps / perFoot), inchSteps = steps - feet * perFoot;
    // Without units whole feet are shown alone (`1'`); otherwise zero inches are kept (`1'-0"`).
    if (feet && !inchSteps && !style.showUnits) return `${feet}'`;
    const rest = `${fractionalInches(inchSteps, denominator, ' ')}"`;
    return feet ? `${feet}'${dash}${rest}` : rest;
  }
  // Engineering keeps its foot mark without units; whole feet drop their decimals.
  if (format === 'engineering') {
    // With no decimals the length rounds to the inch, then shows the whole feet that contains.
    if (precision === 0) return `${Math.floor(roundHalfUp(inches) / 12)}'`;
    const feet = roundHalfUp(inches / 12 * 10 ** precision) / 10 ** precision;
    return `${Number.isInteger(feet) ? feet : feet.toFixed(precision)}'`;
  }
  const [convert, suffix] = DECIMAL_UNITS[style.units];
  // Points show at most one decimal place.
  const places = style.units === 'pt' ? Math.min(precision, 1) : precision;
  const value = roundHalfUp(convert(inches) * 10 ** places) / 10 ** places;
  return `${value.toFixed(places)}${style.showUnits ? suffix : ''}`;
}

/** Precision choices read as the smallest step they show: `0.00` or `1/16"`. */
export function layoutLengthPrecisionLabel(format: LengthFormat | undefined, precision: number): string {
  if (format === 'architectural' || format === 'fractional') return precision ? `1/${2 ** precision}"` : '1"';
  return precision ? `0.${'0'.repeat(precision)}` : '0';
}

/** Common metric and architectural drawing scales. */
export const LAYOUT_DIMENSION_SCALES: readonly { label: string; scale: number }[] = [
  ...[1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].map(ratio => ({ label: `1:${ratio}`, scale: 1 / ratio })),
  ...([['1/16', 1 / 16], ['3/32', 3 / 32], ['1/8', 1 / 8], ['3/16', 3 / 16], ['1/4', 1 / 4], ['3/8', 3 / 8], ['1/2', 1 / 2],
    ['3/4', 3 / 4], ['1', 1], ['1 1/2', 1.5], ['3', 3]] as const).map(([inch, value]) => ({ label: `${inch}" = 1'-0"`, scale: value / 12 })),
];

/** A drawing scale's preset name, else `1:N` (or `N:1` for enlargements). */
export function layoutDimensionScaleLabel(scale: number): string {
  const preset = LAYOUT_DIMENSION_SCALES.find(entry => Math.abs(entry.scale / scale - 1) < RATIO_TOL);
  if (preset) return preset.label;
  const ratio = scale < 1 ? 1 / scale : scale;
  const shown = Number(ratio.toPrecision(6));
  return scale < 1 ? `1:${shown}` : `${shown}:1`;
}

/** Dimension line endpoints projected to the placement point; extension lines start at the measured points. */
export function linearDimensionGeometry(entity: LayoutEntity): {
  a: Point; b: Point; start: Point; end: Point; normal: Point;
} {
  const a = entity.points[0]!, b = entity.points[1]!, place = entity.points[2]!;
  const alignment = entity.dimension!.alignment;
  if (alignment === 'horizontal') return { a, b, start: [a[0], place[1]], end: [b[0], place[1]], normal: [0, 1] };
  if (alignment === 'vertical') return { a, b, start: [place[0], a[1]], end: [place[0], b[1]], normal: [1, 0] };
  if (alignment === 'rotated') {
    // The measured points projected onto the line through the placement point at the dimension's angle.
    const radians = (entity.dimension!.angleDeg ?? 0) * Math.PI / 180, u: Point = [Math.cos(radians), Math.sin(radians)];
    const along = (p: Point) => (p[0] - place[0]) * u[0] + (p[1] - place[1]) * u[1];
    return { a, b, start: [place[0] + u[0] * along(a), place[1] + u[1] * along(a)],
      end: [place[0] + u[0] * along(b), place[1] + u[1] * along(b)], normal: [-u[1], u[0]] };
  }
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const normal: Point = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
  const offset = (place[0] - a[0]) * normal[0] + (place[1] - a[1]) * normal[1];
  return { a, b, start: [a[0] + normal[0] * offset, a[1] + normal[1] * offset],
    end: [b[0] + normal[0] * offset, b[1] + normal[1] * offset], normal };
}


export function createAngularDimension(): LayoutAngularDimension {
  const { alignment: _alignment, cachedValueMm: _value, ...common } = createLinearDimension();
  return { ...common, anchors: [null, null, null], units: 'degrees', reflex: false, cachedAngleDeg: 0 };
}

export function angularMeasurement(vertex: Point, first: Point, second: Point, reflex = false): number | null {
  const a = Math.hypot(first[0] - vertex[0], first[1] - vertex[1]);
  const b = Math.hypot(second[0] - vertex[0], second[1] - vertex[1]);
  if (a < 1e-6 || b < 1e-6) return null;
  if (![...vertex, ...first, ...second, a, b].every(Number.isFinite)) return null;
  const ax = (first[0] - vertex[0]) / a, ay = (first[1] - vertex[1]) / a;
  const bx = (second[0] - vertex[0]) / b, by = (second[1] - vertex[1]) / b;
  const degrees = Math.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by) * 180 / Math.PI;
  return reflex ? 360 - degrees : degrees;
}

/** Validate each angular placement stage without consuming a bad click. Opposite rays form a valid 180° angle. */
export function angularDimensionError(points: readonly Point[]): string | null {
  if (points.some(point => !point.every(Number.isFinite))) return 'Angular dimension points must be finite.';
  const [vertex, first, second, placement] = points;
  if (!vertex) return null;
  if (first && Math.hypot(first[0] - vertex[0], first[1] - vertex[1]) < 1e-6)
    return 'Choose the first ray point away from the vertex.';
  if (second) {
    const angle = first ? angularMeasurement(vertex, first, second) : null;
    if (angle === null) return 'Choose the second ray point away from the vertex.';
    if (angle < 1e-6) return 'Angular dimension needs two distinct rays. Choose a different second direction.';
  }
  if (placement && Math.hypot(placement[0] - vertex[0], placement[1] - vertex[1]) < 0.5)
    return 'Place the dimension arc at least 0.5 mm away from the vertex.';
  return null;
}

export function formatAngularDimension(dim: LayoutAngularDimension): string {
  const value = dim.units === 'radians' ? dim.cachedAngleDeg * Math.PI / 180 : dim.cachedAngleDeg;
  return dim.text.replaceAll('<>', `${value.toFixed(dim.precision)}${dim.showUnits ? dim.units === 'degrees' ? '°' : ' rad' : ''}`);
}

/** Choose the sweep containing the placement point; either ray boundary belongs to the inside angle. */
export function angularPlacementReflex(vertex: Point, first: Point, second: Point, placement: Point): boolean {
  const start = Math.atan2(first[1] - vertex[1], first[0] - vertex[0]);
  let sweep = Math.atan2(second[1] - vertex[1], second[0] - vertex[0]) - start;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;
  const turn = Math.PI * 2;
  const offset = Math.atan2(placement[1] - vertex[1], placement[0] - vertex[0]) - start;
  const distance = (((sweep < 0 ? -offset : offset) % turn) + turn) % turn;
  return distance > Math.abs(sweep) + 1e-10 && turn - distance > 1e-10;
}

export function angularDimensionGeometry(entity: LayoutEntity): {
  vertex: Point; radius: number; startAngle: number; sweep: number; start: Point; end: Point; text: Point; arc: Point[];
} {
  const [vertex, first, second, placement] = entity.points as [Point, Point, Point, Point];
  const startAngle = Math.atan2(first[1] - vertex[1], first[0] - vertex[0]);
  let sweep = Math.atan2(second[1] - vertex[1], second[0] - vertex[0]) - startAngle;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;
  if (entity.angularDimension!.reflex) sweep += sweep <= 0 ? Math.PI * 2 : -Math.PI * 2;
  const radius = Math.max(0.5, Math.hypot(placement[0] - vertex[0], placement[1] - vertex[1]));
  const at = (angle: number, r = radius): Point => [vertex[0] + r * Math.cos(angle), vertex[1] + r * Math.sin(angle)];
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) * 16));
  const arc = Array.from({ length: steps + 1 }, (_, i) => at(startAngle + sweep * i / steps));
  return { vertex, radius, startAngle, sweep, start: arc[0]!, end: arc.at(-1)!,
    text: at(startAngle + sweep / 2, radius + 2), arc };
}
