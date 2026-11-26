// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  ANGLE_TOL,
  AREA_TOL,
  LENGTH_TOL,
  MERGE_TOL,
  PushFormError,
  basisToLocal,
  basisToWorld,
  m4identity,
  m4invert,
  m4mul,
  m4transformDir,
  m4transformPoint,
  m4translation,
  planeBasis,
  v3add,
  v3dist,
  v3dot,
  v3len,
  v3scale,
  v3sub,
  type CurveId,
  type FaceLocalId,
  type Mat4,
  type MMat4,
  type Vec3,
} from '@pushform/core';
import { KernelError, toMeshWire, type KernelClient } from '@pushform/kernel';
import {
  createEntityContainer,
  faceContainsPoint,
  foldAndTriangulate,
  overlapRatio,
  polyMeshFromBody,
  reconcileBody,
  segmentFaceSpans,
  uvRebaseSides,
  type Body,
  type Curve,
  type EdgeRecord,
  type KernelResult,
  type TextureTileOf,
} from '@pushform/model';

/** World-space planes and translations; offset means normal dot point = offset. */
export interface StretchPlane {
  readonly normal: Vec3;
  readonly offset: number;
  readonly side: 'positive' | 'negative';
  readonly displacement: Vec3;
}
export interface BodyStretchOptions {
  readonly world: Mat4 | MMat4;
  readonly planes: readonly StretchPlane[];
  readonly anchor?: Vec3;
  readonly tiles?: TextureTileOf;
  readonly signal?: AbortSignal;
}
export interface PreparedBodyStretch {
  /** Trusted native identities, never serialized or exposed to extension guests. */
  readonly source: Body;
  readonly body: Body;
  readonly changed: boolean;
}
function fail(reason: string, message: string): never {
  throw new PushFormError(`stretch.${reason}`, message);
}
const finite = (p: Vec3): boolean => p.length === 3 && p.every(Number.isFinite);
const checkAbort = (signal?: AbortSignal): void => {
  signal?.throwIfAborted();
};
const pair = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
const edgeLength = (edge: EdgeRecord): number =>
  edge.polyline.slice(1).reduce((sum, p, i) => sum + v3dist(p, edge.polyline[i]!), 0);

/** Read-only deformation field. Boundary points stay on the stationary side. */
export function stretchMapping(options: BodyStretchOptions): {
  point: (local: Vec3) => Vec3;
  translation: (world: Vec3) => Vec3;
} {
  const { world, planes, anchor } = options,
    inverse = m4invert(world);
  if (
    world.length !== 16 ||
    !world.every(Number.isFinite) ||
    world[3] !== 0 ||
    world[7] !== 0 ||
    world[11] !== 0 ||
    world[15] !== 1 ||
    !inverse?.every(Number.isFinite)
  )
    fail('frame', 'Stretch needs an invertible affine occurrence transform.');
  if (
    planes.length === 0 ||
    planes.length > 32 ||
    planes.some(
      (p) =>
        !finite(p.normal) ||
        Math.abs(v3len(p.normal) - 1) > ANGLE_TOL ||
        !Number.isFinite(p.offset) ||
        !finite(p.displacement) ||
        (p.side !== 'positive' && p.side !== 'negative'),
    ) ||
    (anchor && !finite(anchor))
  )
    fail('planes', 'Choose between one and 32 finite stretch planes with unit normals.');
  const raw = (p: Vec3): Vec3 =>
    planes.reduce(
      (sum, plane) => {
        const distance =
          (v3dot(plane.normal, p) - plane.offset) * (plane.side === 'positive' ? 1 : -1);
        return distance > LENGTH_TOL ? v3add(sum, plane.displacement) : sum;
      },
      [0, 0, 0] as Vec3,
    );
  const correction: Vec3 = anchor ? v3scale(raw(anchor), -1) : [0, 0, 0];
  const translation = (p: Vec3): Vec3 => v3add(raw(p), correction);
  return {
    translation,
    point: (p) => {
      const w = m4transformPoint(world, p);
      return m4transformPoint(inverse!, v3add(w, translation(w)));
    },
  };
}

/** Exact projected range of the authored circular arc, including extrema between tessellation points. */
function circularRange(curve: Curve, world: Mat4 | MMat4, normal: Vec3): [number, number] {
  if (
    !finite(curve.center) ||
    !finite(curve.normal) ||
    Math.abs(v3len(curve.normal) - 1) > ANGLE_TOL ||
    !Number.isFinite(curve.radius) ||
    curve.radius <= 0 ||
    !Number.isFinite(curve.startAngle) ||
    !Number.isFinite(curve.endAngle)
  )
    fail('curve', 'Repair the invalid native curve before stretching.');
  const basis = planeBasis(curve.center, curve.normal),
    center = v3dot(normal, m4transformPoint(world, curve.center));
  const a = curve.radius * v3dot(normal, m4transformDir(world, basis.u)),
    b = curve.radius * v3dot(normal, m4transformDir(world, basis.v));
  const radius = Math.hypot(a, b);
  if (curve.kind === 'circle' || Math.abs(curve.endAngle - curve.startAngle) >= 2 * Math.PI)
    return [center - radius, center + radius];
  const at = (angle: number): number => center + a * Math.cos(angle) + b * Math.sin(angle);
  const lo = Math.min(curve.startAngle, curve.endAngle),
    hi = Math.max(curve.startAngle, curve.endAngle);
  const values = [at(lo), at(hi)],
    phase = Math.atan2(b, a);
  for (const extremum of [phase, phase + Math.PI])
    if (Math.ceil((lo - extremum) / (2 * Math.PI)) <= Math.floor((hi - extremum) / (2 * Math.PI)))
      values.push(at(extremum));
  return [Math.min(...values), Math.max(...values)];
}

function curvePoints(body: Body, curve: Curve): Vec3[] {
  const points: Vec3[] = [];
  if (new Set(curve.edgeRefs).size !== curve.edgeRefs.length)
    fail('curve', 'Repair the duplicate native curve references before stretching.');
  for (const ref of curve.edgeRefs) {
    if (typeof ref === 'string') {
      const edge = body.edges.get(ref as never);
      if (!edge || edge.curveId !== curve.id)
        fail('curve', 'Repair the missing native curve edges before stretching.');
      points.push(...edge.polyline);
    } else {
      const matches = [...body.imprints].flatMap(([fid, graph]) => {
        const edge = graph.edges.get(ref),
          face = body.faces.get(fid);
        if (!edge || edge.curveId !== curve.id || !face) return [];
        const a = graph.vertices.get(edge.a),
          b = graph.vertices.get(edge.b);
        if (!a || !b) fail('imprint', 'Repair the incomplete machining marks before stretching.');
        return [basisToWorld(face.basis, a[0], a[1]), basisToWorld(face.basis, b[0], b[1])];
      });
      if (!matches.length)
        fail('curve', 'Repair the missing imprint curve edges before stretching.');
      points.push(...matches);
    }
  }
  if (!points.length || points.some((p) => !finite(p)))
    fail('curve', 'Repair the incomplete native curve before stretching.');
  return points;
}

/** Returns local translations; a curve center need not lie on the arc itself. */
function curveTranslations(
  body: Body,
  options: BodyStretchOptions,
  mapping: ReturnType<typeof stretchMapping>,
): Map<CurveId, Vec3> {
  const result = new Map<CurveId, Vec3>(),
    inverse = m4invert(options.world)!;
  for (const edge of body.edges.values())
    if (edge.curveId !== null && !body.curves.get(edge.curveId)?.edgeRefs.includes(edge.key))
      fail('curve', 'Repair the incomplete native curve ownership before stretching.');
  for (const graph of body.imprints.values())
    for (const edge of graph.edges.values())
      if (
        edge.curveId !== null &&
        !body.curves.get(edge.curveId)?.edgeRefs.includes(edge.id as never)
      )
        fail('curve', 'Repair the incomplete imprint curve ownership before stretching.');
  for (const curve of body.curves.values()) {
    const points = curvePoints(body, curve).map((p) => m4transformPoint(options.world, p));
    for (const plane of options.planes) {
      if (v3len(plane.displacement) === 0) continue;
      let min = Infinity,
        max = -Infinity;
      for (const point of points) {
        const d = v3dot(plane.normal, point);
        min = Math.min(min, d);
        max = Math.max(max, d);
      }
      if (curve.kind === 'circle' || curve.kind === 'arc') {
        const range = circularRange(curve, options.world, plane.normal);
        min = Math.min(min, range[0]);
        max = Math.max(max, range[1]);
      }
      const side =
        plane.side === 'positive'
          ? [min - plane.offset, max - plane.offset]
          : [plane.offset - max, plane.offset - min];
      if (side[0]! <= LENGTH_TOL && side[1]! > LENGTH_TOL)
        fail('curveCrossing', 'Move the stretch plane clear of the curved detail.');
    }
    const displacement = mapping.translation(points[0]!);
    if (points.some((p) => v3dist(mapping.translation(p), displacement) > LENGTH_TOL))
      fail('curveCrossing', 'The curved detail must move intact.');
    result.set(curve.id, m4transformDir(inverse, displacement));
  }
  return result;
}

/**
 * Prepare one native body without touching its document, clipboard, selection or kernel body cache.
 * Assembly isolation, revision checks and fitting dimension proof belong to the calling command.
 */
export async function prepareBodyStretch(
  kernel: KernelClient,
  source: Body,
  options: BodyStretchOptions,
): Promise<PreparedBodyStretch> {
  options = {
    ...options,
    world: [...options.world] as unknown as Mat4,
    planes: options.planes.map((plane) => ({
      ...plane,
      normal: [...plane.normal],
      displacement: [...plane.displacement],
    })),
    ...(options.anchor ? { anchor: [...options.anchor] as Vec3 } : {}),
  };
  checkAbort(options.signal);
  if (!source.valid || source.locked) fail('body', 'Choose an unlocked, valid solid to stretch.');
  const mapping = stretchMapping(options),
    curves = curveTranslations(source, options, mapping),
    poly = polyMeshFromBody(source);
  const verts = poly.verts.map(mapping.point);
  if (verts.some((p) => !finite(p)))
    fail('range', 'The stretch exceeds the supported coordinate range.');
  const unmoved = (p: Vec3): boolean =>
    v3len(mapping.translation(m4transformPoint(options.world, p))) <= LENGTH_TOL;
  if (
    poly.verts.every(unmoved) &&
    [...source.imprints].every(([fid, graph]) => {
      const face = source.faces.get(fid);
      if (!face) fail('imprint', 'Repair the missing machining-mark face before stretching.');
      return [...graph.vertices.values()].every((p) =>
        unmoved(basisToWorld(face.basis, p[0], p[1])),
      );
    }) &&
    [...curves.values()].every((shift) => v3len(m4transformDir(options.world, shift)) <= LENGTH_TOL)
  )
    return { source, body: source, changed: false };
  const fold = foldAndTriangulate({ ...poly, verts });
  checkAbort(options.signal);
  // Autofold owns a temporary Manifold and does not upload or replace a body cache entry.
  let components;
  try {
    components = await kernel.autofold({
      body: { bodyId: source.id, version: source.version },
      mesh: toMeshWire(fold.mesh),
      nextFaceId: fold.nextFaceId,
    });
  } catch (error) {
    if (error instanceof KernelError)
      fail('invalidSolid', 'The stretch would create an invalid solid.');
    throw error;
  }
  checkAbort(options.signal);
  const component = components.components[0];
  if (
    components.components.length !== 1 ||
    !component ||
    !Number.isFinite(component.props.volume) ||
    !Number.isFinite(component.props.area) ||
    component.props.volume <= AREA_TOL * LENGTH_TOL ||
    component.props.area <= AREA_TOL
  )
    fail('invalidSolid', 'The stretch must retain one closed solid with positive volume.');
  const faceOrigin: KernelResult['faceOrigin'] = new Map(
    [...component.faceOrigin].map(([id, origins]) => [
      id as FaceLocalId,
      origins.map((origin) => ({
        ...origin,
        faceId: fold.faceOrigin.get(origin.faceId as FaceLocalId) ?? (origin.faceId as FaceLocalId),
      })),
    ]),
  );
  const body = structuredClone(source);
  const shift = v3sub(verts[0]!, poly.verts[0]!);
  if (
    poly.verts.every(
      (point, i) =>
        v3len(m4transformDir(options.world, v3sub(v3sub(verts[i]!, point), shift))) <= LENGTH_TOL,
    )
  )
    body.referenceFrame = m4mul(
      m4translation(shift),
      source.referenceFrame ?? m4identity(),
    ) as Mat4;
  // Link native topology continuation to the captured immutable mesh, not a detached clone.
  body.mesh = source.mesh;
  for (const edge of body.edges.values()) edge.polyline = edge.polyline.map(mapping.point);
  reconcileBody(body, { mesh: component.mesh, faceOrigin, props: component.props });
  const ownOrigin = (id: FaceLocalId): FaceLocalId | undefined => {
    const origins = new Set(faceOrigin.get(id)?.map((o) => o.faceId));
    return origins.size === 1 ? origins.values().next().value : undefined;
  };
  const edgesByPair = new Map<string, EdgeRecord[]>();
  for (const edge of source.edges.values()) {
    const key = pair(edge.faceA, edge.faceB),
      list = edgesByPair.get(key) ?? [];
    list.push({ ...edge, polyline: edge.polyline.map(mapping.point) });
    edgesByPair.set(key, list);
  }
  const retainedLength = new Map<string, number>();
  for (const edge of body.edges.values()) {
    const a = ownOrigin(edge.faceA),
      b = ownOrigin(edge.faceB);
    if (a === undefined || b === undefined) continue;
    const length = edgeLength(edge);
    const matches = (edgesByPair.get(pair(a, b)) ?? []).filter(
      (old) =>
        overlapRatio(edge.polyline, old.polyline, MERGE_TOL) >=
        1 - MERGE_TOL / Math.max(length, MERGE_TOL),
    );
    if (matches.length > 1) fail('detail', 'The stretched edge properties are ambiguous.');
    const old = matches[0];
    if (!old) continue;
    edge.soft = old.soft;
    edge.smooth = old.smooth;
    edge.hidden = old.hidden;
    edge.tagId = old.tagId;
    edge.curveId = old.curveId;
    retainedLength.set(old.key, (retainedLength.get(old.key) ?? 0) + length);
  }
  for (const edge of source.edges.values())
    if (
      edge.curveId !== null ||
      edge.soft ||
      edge.smooth ||
      edge.hidden ||
      edge.tagId !== source.tagId
    ) {
      const expected = edgeLength({ ...edge, polyline: edge.polyline.map(mapping.point) });
      if (Math.abs((retainedLength.get(edge.key) ?? 0) - expected) > MERGE_TOL)
        fail('detail', 'The stretch could not retain every decorated native edge.');
    }
  body.curves = new Map(
    [...source.curves].map(([id, curve]) => [
      id,
      {
        ...structuredClone(curve),
        center: v3add(curve.center, curves.get(id)!),
        edgeRefs: [
          ...[...body.edges.values()].filter((e) => e.curveId === id).map((e) => e.key),
          ...curve.edgeRefs.filter((ref) => typeof ref === 'number'),
        ],
      },
    ]),
  );
  for (const face of body.faces.values()) {
    const old = source.faces.get(ownOrigin(face.id)!);
    if (!old) fail('detail', 'The stretched face appearance could not be retained.');
    const points = old.loops.flat(),
      shift = v3sub(mapping.point(points[0]!), points[0]!);
    const rigid = points.every((p) => v3dist(v3sub(mapping.point(p), p), shift) <= LENGTH_TOL);
    Object.assign(
      face,
      uvRebaseSides(
        old,
        old.basis,
        face.basis,
        options.tiles?.(old.frontMaterialId ?? source.materialId) ?? null,
        options.tiles?.(old.backMaterialId ?? source.materialId) ?? null,
        rigid ? (p) => v3add(p, shift) : (p) => p,
      ),
    );
  }
  // Reproject complete imprint graphs onto their proven surviving face; refuse lost/split marks.
  body.imprints.clear();
  const container = createEntityContainer();
  container.bodies.set(body.id, { ...body, hidden: false });
  for (const [fid, graph] of source.imprints) {
    const old = source.faces.get(fid);
    if (!old) fail('imprint', 'Repair the missing machining-mark face before stretching.');
    const points = new Map(
      [...graph.vertices].map(([id, p]) => [
        id,
        mapping.point(basisToWorld(old.basis, p[0], p[1])),
      ]),
    );
    const matches = [...body.faces.values()].filter(
      (face) =>
        ownOrigin(face.id) === fid && [...points.values()].every((p) => faceContainsPoint(face, p)),
    );
    if (matches.length !== 1)
      fail('imprint', 'The stretch cannot retain these machining marks on one face.');
    const face = matches[0]!;
    for (const edge of graph.edges.values()) {
      const a = points.get(edge.a),
        b = points.get(edge.b);
      if (!a || !b) fail('imprint', 'Repair the incomplete machining marks before stretching.');
      if (
        v3dist(a, b) <= MERGE_TOL ||
        !segmentFaceSpans(container, a, b).some(
          (span) => span.faceId === face.id && span.t0 === 0 && span.t1 === 1,
        )
      )
        fail('imprint', 'The stretch would collapse or move a machining mark off its face.');
    }
    const kept = structuredClone(graph);
    kept.version++;
    kept.vertices = new Map(
      [...points].map(([id, p]) => {
        const uv = basisToLocal(face.basis, p);
        return [id, [uv[0], uv[1]]];
      }),
    );
    body.imprints.set(face.id, kept);
  }
  for (const [id, surface] of source.surfaces) {
    const faces = [...body.faces.values()].filter((face) =>
      surface.faceIds.includes(ownOrigin(face.id)!),
    );
    if (!faces.length) fail('detail', 'The stretch could not retain a native curved surface.');
    body.surfaces.set(id, { ...structuredClone(surface), faceIds: faces.map((face) => face.id) });
    for (const face of faces) face.surfaceId = id;
  }
  checkAbort(options.signal);
  return { source, body, changed: true };
}
