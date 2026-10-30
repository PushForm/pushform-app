// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Follow Me: sweep a planar profile along a polyline path as a union of per-segment prisms.
 *
 * The profile is projected (along the first segment) onto the plane perpendicular to that segment
 * through the start vertex, then carried from joint to joint: at every joint the cross-section is
 * projected along the incoming segment onto the mitre plane (normal = bisector of the two segment
 * directions), so consecutive prisms share that face exactly. Each prism is built as an explicit
 * closed mesh (two earcut caps + a quad strip per profile ring), so non-convex profiles and holes
 * work; the prisms are unioned and finalized. Closed paths mitre the start joint too.
 */
import type { Manifold } from 'manifold-3d';
import { box3Center, box3FromPositions } from '@pushform/core';
import { AREA_TOL, MERGE_TOL, basisToWorld, meshSignedVolume, v3add, v3addScaled, v3dist, v3dot, v3len, v3normalize, v3scale, v3sub, type Vec3 } from '@pushform/core';
import { normalizePolygon, signedArea, triangulatePolygon } from '@pushform/geom';
import type { ComponentsResult, FollowMeRequest } from '../../protocol';
import { KernelError } from '../../protocol';
import type { KernelContext } from '../context';
import { withScope, type Scope } from '../context';
import type { TriangleSoup } from '../meshio';
import { finalizeManifold } from './finalize';
import { allNewIds } from './normalize';

/** Face labels inside one prism; sides are `SIDE_BASE + flattened profile edge index`. */
const CAP_START = 0;
const CAP_END = 1;
const SIDE_BASE = 2;

/** Profile vertices (all rings, outer first) with a cap triangulation that is valid for every section. */
interface Profile {
  points: Vec3[];
  ringStarts: number[];
  capTris: Uint32Array;
}

function buildProfile(req: FollowMeRequest): Profile {
  const norm = normalizePolygon(req.profile).filter((ring) => ring.length >= 3);
  if (norm.length === 0 || Math.abs(signedArea(norm[0]!)) <= AREA_TOL) {
    throw new KernelError('InvalidInput', 'followMe.profile has no area');
  }
  const tri = triangulatePolygon(norm);
  const points: Vec3[] = [];
  for (let k = 0; k < tri.coords.length; k += 2) points.push(basisToWorld(req.profileBasis, tri.coords[k]!, tri.coords[k + 1]!));
  return { points, ringStarts: tri.ringStarts, capTris: tri.indices };
}

/** Drop repeated vertices; a closed path also drops a repeated first vertex at the end. */
function cleanPath(path: readonly Vec3[], closed: boolean): Vec3[] {
  const pts: Vec3[] = [];
  for (const p of path) {
    if (p.some((x) => !Number.isFinite(x))) throw new KernelError('InvalidInput', 'followMe.path has a non-finite vertex');
    if (pts.length === 0 || v3dist(pts[pts.length - 1]!, p) > MERGE_TOL) pts.push([p[0], p[1], p[2]]);
  }
  if (closed && pts.length > 1 && v3dist(pts[0]!, pts[pts.length - 1]!) <= MERGE_TOL) pts.pop();
  return pts;
}

/** Start the sweep at the path vertex nearest the profile (open: nearer endpoint; closed: rotate). */
function orientPath(pts: Vec3[], closed: boolean, anchor: Vec3): Vec3[] {
  if (!closed) return v3dist(anchor, pts[pts.length - 1]!) < v3dist(anchor, pts[0]!) ? [...pts].reverse() : pts;
  let best = 0, bestD = Infinity;
  pts.forEach((p, i) => {
    const d = v3dist(anchor, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return [...pts.slice(best), ...pts.slice(0, best)];
}

/** Project `points` along `dir` onto the plane (planePoint, planeNormal). */
function projectAlong(points: readonly Vec3[], dir: Vec3, planePoint: Vec3, planeNormal: Vec3): Vec3[] {
  const denom = v3dot(dir, planeNormal);
  if (Math.abs(denom) < 1e-9) throw new KernelError('InvalidInput', 'followMe.path doubles back on itself');
  return points.map((q) => v3addScaled(q, dir, v3dot(v3sub(planePoint, q), planeNormal) / denom));
}

function bisector(a: Vec3, b: Vec3): Vec3 {
  const s = v3add(a, b);
  if (v3len(s) < 1e-9) throw new KernelError('InvalidInput', 'followMe.path doubles back on itself');
  return v3normalize(s);
}

/** Cross-sections at every joint: `sections[i]` lies on joint i's plane; segment i runs from i to i+1. */
function sweepSections(profile: Profile, path: Vec3[], closed: boolean): Vec3[][] {
  const n = path.length;
  const numSeg = closed ? n : n - 1;
  const dirs: Vec3[] = [];
  for (let i = 0; i < numSeg; i++) dirs.push(v3normalize(v3sub(path[(i + 1) % n]!, path[i]!)));

  const d0 = dirs[0]!;
  let start = projectAlong(profile.points, d0, path[0]!, d0);
  if (closed) start = projectAlong(start, d0, path[0]!, bisector(dirs[numSeg - 1]!, d0));
  const sections: Vec3[][] = [start];
  for (let i = 0; i < numSeg; i++) {
    const end = path[(i + 1) % n]!;
    const hasNext = closed || i + 1 < numSeg;
    const planeNormal = hasNext ? bisector(dirs[i]!, dirs[(i + 1) % numSeg]!) : dirs[i]!;
    sections.push(projectAlong(sections[i]!, dirs[i]!, end, planeNormal));
  }
  return sections;
}

/** Closed prism between two sections with the same vertex order; winding fixed by signed volume. */
function prismSoup(profile: Profile, a: readonly Vec3[], b: readonly Vec3[]): TriangleSoup {
  const N = a.length;
  const verts = new Float64Array(N * 6);
  for (let i = 0; i < N; i++) {
    verts.set(a[i]!, i * 3);
    verts.set(b[i]!, (N + i) * 3);
  }
  const tris: number[] = [], faceId: number[] = [];
  const cap = profile.capTris;
  for (let t = 0; t + 2 < cap.length; t += 3) {
    tris.push(cap[t]!, cap[t + 2]!, cap[t + 1]!);
    faceId.push(CAP_START);
    tris.push(N + cap[t]!, N + cap[t + 1]!, N + cap[t + 2]!);
    faceId.push(CAP_END);
  }
  let edge = 0;
  for (let r = 0; r < profile.ringStarts.length; r++) {
    const s = profile.ringStarts[r]!;
    const e = r + 1 < profile.ringStarts.length ? profile.ringStarts[r + 1]! : N;
    for (let i = s; i < e; i++) {
      const j = i + 1 < e ? i + 1 : s;
      tris.push(i, j, N + j, i, N + j, N + i);
      faceId.push(SIDE_BASE + edge, SIDE_BASE + edge);
      edge++;
    }
  }
  const soup: TriangleSoup = { verts, tris: Uint32Array.from(tris), faceId: Uint32Array.from(faceId) };
  const volume = meshSignedVolume(soup);
  if (Math.abs(volume) <= AREA_TOL) throw new KernelError('InvalidInput', 'followMe produced a degenerate segment');
  if (volume < 0) {
    for (let t = 0; t < soup.tris.length; t += 3) {
      const tmp = soup.tris[t + 1]!;
      soup.tris[t + 1] = soup.tris[t + 2]!;
      soup.tris[t + 2] = tmp;
    }
  }
  return soup;
}

/**
 * Like `manifoldFromSoup`, but every prism is quantized to float32 about the same `center` so the
 * vertices two prisms share on a mitre plane land on identical coordinates and the union is exact.
 */
function segmentManifold(ctx: KernelContext, scope: Scope, soup: TriangleSoup, runId: number, center: Vec3, index: number): Manifold {
  const n = soup.verts.length;
  const props = new Float32Array(n);
  for (let i = 0; i < n; i += 3) {
    props[i] = soup.verts[i]! - center[0];
    props[i + 1] = soup.verts[i + 1]! - center[1];
    props[i + 2] = soup.verts[i + 2]! - center[2];
  }
  const mesh = new ctx.wasm.Mesh({
    numProp: 3,
    vertProperties: props,
    triVerts: soup.tris,
    faceID: soup.faceId,
    runIndex: new Uint32Array([0, soup.tris.length]),
    runOriginalID: new Uint32Array([runId]),
  });
  let local: Manifold;
  try {
    local = scope.track(new ctx.wasm.Manifold(mesh));
  } catch (e) {
    const status = (e as { code?: unknown } | null)?.code;
    throw new KernelError('ManifoldError', `followMe segment ${index} is not a valid solid (${String(status ?? 'Unknown')})`, { status, segment: index });
  }
  const status = local.status();
  if (status !== 'NoError') {
    throw new KernelError('ManifoldError', `followMe segment ${index} is not a valid solid (${status})`, { status, segment: index });
  }
  return scope.track(local.translate(center[0], center[1], center[2]));
}

/** Sweep `profile` along `path`; one solid per connected component, all faces new. */
export function followMe(ctx: KernelContext, req: FollowMeRequest): ComponentsResult {
  const profile = buildProfile(req);
  const cleaned = cleanPath(req.path, req.closed);
  if (cleaned.length < (req.closed ? 3 : 2)) throw new KernelError('InvalidInput', 'followMe.path needs at least two distinct vertices (three when closed)');
  const outerEnd = profile.ringStarts[1] ?? profile.points.length;
  const anchor = v3scale(profile.points.slice(0, outerEnd).reduce((acc, p) => v3add(acc, p), [0, 0, 0] as Vec3), 1 / outerEnd);
  const path = orientPath(cleaned, req.closed, anchor);
  const d0 = v3normalize(v3sub(path[1]!, path[0]!));
  if (Math.abs(v3dot(req.profileBasis.n, d0)) < 1e-6) {
    throw new KernelError('InvalidInput', 'followMe.profile plane is parallel to the first path segment');
  }
  const sections = sweepSections(profile, path, req.closed);
  const runId = ctx.wasm.Manifold.reserveIDs(1);
  const center = box3Center(box3FromPositions(sections.flat(2)));
  return withScope((scope) => {
    const segments: Manifold[] = [];
    for (let i = 0; i + 1 < sections.length; i++) {
      segments.push(segmentManifold(ctx, scope, prismSoup(profile, sections[i]!, sections[i + 1]!), runId, center, i));
    }
    const solid = segments.length === 1 ? segments[0]! : scope.track(ctx.wasm.Manifold.union(segments));
    const fin = finalizeManifold(ctx, solid, { nextFaceId: req.nextFaceId, chooseId: allNewIds });
    return { components: fin.components, nextFaceId: fin.nextFaceId };
  });
}
