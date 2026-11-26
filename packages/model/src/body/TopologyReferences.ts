// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { isDraft, original } from 'immer';
import type { FaceLocalId, MeshData } from '@pushform/core';
import type { Body, EdgeKey, EdgeRecord, FaceRecord } from '../entities/body';
import type { KernelResult } from './Reconcile';

/** A topology address is valid only at the geometry version at which it was captured. */
export type TopologyElement = { kind: 'face'; faceId: number; bodyVersion: number }
  | { kind: 'edge'; edgeKey: string; bodyVersion: number };
interface Continuation {
  source: WeakRef<MeshData>;
  from: number;
  to: number;
  faces: ReadonlyMap<number, number> | null;
  edges: ReadonlyMap<string, string> | null;
}
const continuations = new WeakMap<MeshData, Continuation>();
const raw = (mesh: MeshData): MeshData => isDraft(mesh) ? original(mesh)! : mesh;

/** Ephemeral proof from a modeling operation, never serialized or supplied by a plugin. */
export function recordTopologyContinuation(source: MeshData, from: number, mesh: MeshData, to: number,
  faces: ReadonlyMap<number, number> | null, edges: ReadonlyMap<string, string> | null): void {
  if (raw(source) === raw(mesh)) return;
  continuations.set(raw(mesh), { source: new WeakRef(raw(source)), from, to, faces, edges });
}

function sameConnectivity(a: MeshData, b: MeshData): boolean {
  if (a.verts.length !== b.verts.length || a.tris.length !== b.tris.length || a.faceId.length !== b.faceId.length) return false;
  for (let i = 0; i < a.faceId.length; i++) {
    if (a.faceId[i] !== b.faceId[i]) return false;
    // Reversing winding for a reflection does not change the identity of a triangle.
    const a0 = a.tris[i * 3]!, a1 = a.tris[i * 3 + 1]!, a2 = a.tris[i * 3 + 2]!;
    const b0 = b.tris[i * 3]!, b1 = b.tris[i * 3 + 1]!, b2 = b.tris[i * 3 + 2]!;
    if (Math.min(a0, a1, a2) !== Math.min(b0, b1, b2) || Math.max(a0, a1, a2) !== Math.max(b0, b1, b2) || a0 + a1 + a2 !== b0 + b1 + b2) return false;
  }
  return true;
}

/** Record only bijective own-face provenance; dominant origins cannot prove attachment identity. */
export function recordKernelTopology(body: Body, result: KernelResult, faces: ReadonlyMap<FaceLocalId, FaceRecord>, edges: ReadonlyMap<EdgeKey, EdgeRecord>): void {
  const faceMap = new Map<number, number>(), candidates = new Map<number, number>();
  const unchanged = result.faceOrigin.size === 0 && !result.foreign?.length && sameConnectivity(body.mesh, result.mesh);
  if (unchanged) for (const id of faces.keys()) { if (body.faces.has(id)) faceMap.set(id, id); }
  else {
    const originsByOutput = new Map<number, Set<number>>();
    for (const id of faces.keys()) {
      const origins = result.faceOrigin.get(id) ?? [];
      for (const origin of new Set(origins.filter(origin => (result.selfRunId === undefined || origin.runId === result.selfRunId) && body.faces.has(origin.faceId)).map(origin => origin.faceId))) candidates.set(origin, (candidates.get(origin) ?? 0) + 1);
      if (!origins.length || result.foreign?.length && result.selfRunId === undefined) continue;
      if (origins.some(origin => result.selfRunId !== undefined && origin.runId !== result.selfRunId || !body.faces.has(origin.faceId))) continue;
      const own = new Set(origins.map(origin => origin.faceId));
      originsByOutput.set(id, own);
    }
    for (const [output, origins] of originsByOutput) if (origins.size === 1) {
      const origin = origins.values().next().value!;
      if (candidates.get(origin) === 1) faceMap.set(origin, output);
    }
  }
  if (result.faceContinuations) {
    const counts = new Map<number, number>();
    for (const target of result.faceContinuations.values()) counts.set(target, (counts.get(target) ?? 0) + 1);
    for (const [origin, target] of result.faceContinuations) if (body.faces.has(origin) && faces.has(target) && counts.get(target) === 1 && ![...faceMap].some(([other, output]) => other !== origin && output === target)) faceMap.set(origin, target);
  }
  const edgeMap = new Map<string, string>();
  const pair = (a: number, b: number): string => a < b ? `${a}:${b}` : `${b}:${a}`;
  const oldPairs = new Map<string, EdgeRecord[]>(), newPairs = new Map<string, EdgeRecord[]>();
  for (const edge of body.edges.values()) {
    const a = faceMap.get(edge.faceA), b = faceMap.get(edge.faceB);
    if (a === undefined || b === undefined) continue;
    const key = pair(a, b), list = oldPairs.get(key); if (list) list.push(edge); else oldPairs.set(key, [edge]);
  }
  for (const edge of edges.values()) { const key = pair(edge.faceA, edge.faceB), list = newPairs.get(key); if (list) list.push(edge); else newPairs.set(key, [edge]); }
  for (const [key, previous] of oldPairs) {
    const next = newPairs.get(key) ?? [];
    if (previous.length === 1 && next.length === 1) edgeMap.set(previous[0]!.key, next[0]!.key);
    else if (unchanged) {
      // Multiple runs between a face pair need matching vertex connectivity, not matching run indices.
      const signatures = (mesh: MeshData, values: EdgeRecord[]): Map<string, EdgeRecord[]> => {
        const vertices = new Map<string, number[]>();
        for (let i = 0; i < mesh.verts.length; i += 3) {
          const key = `${mesh.verts[i]},${mesh.verts[i + 1]},${mesh.verts[i + 2]}`;
          const list = vertices.get(key); if (list) list.push(i / 3); else vertices.set(key, [i / 3]);
        }
        const out = new Map<string, EdgeRecord[]>();
        for (const edge of values) {
          const points = edge.polyline.map(point => vertices.get(point.join(','))?.join(','));
          if (points.some(value => value === undefined)) continue;
          const key = [points.join('/'), points.reverse().join('/')].sort()[0]!;
          const list = out.get(key); if (list) list.push(edge); else out.set(key, [edge]);
        }
        return out;
      };
      const oldRuns = signatures(body.mesh, previous), newRuns = signatures(result.mesh, next);
      for (const [signature, old] of oldRuns) {
        const matches = newRuns.get(signature);
        if (old.length === 1 && matches?.length === 1) edgeMap.set(old[0]!.key, matches[0]!.key);
      }
    }
  }
  recordTopologyContinuation(body.mesh, body.version, result.mesh, body.version + 1, faceMap, edgeMap);
}

/** Follow the host's transaction receipts. No receipt or ambiguous provenance means no mapping. */
export function continueTopologyElement(body: Body, element: TopologyElement, copied = false): TopologyElement | undefined {
  const receipts: Continuation[] = [], seen = new Set<MeshData>();
  let mesh = raw(body.mesh), version = body.version;
  while (version !== element.bodyVersion || copied && receipts.length === 0 && continuations.has(mesh)) {
    if (seen.has(mesh)) return undefined;
    seen.add(mesh);
    const receipt = continuations.get(mesh), source = receipt?.source.deref();
    if (!receipt || !source || receipt.to !== version) return undefined;
    receipts.push(receipt); mesh = source; version = receipt.from;
  }
  let mapped = element;
  for (const receipt of receipts.reverse()) {
    if (mapped.kind === 'face') {
      const faceId = receipt.faces === null ? mapped.faceId : receipt.faces.get(mapped.faceId);
      if (faceId === undefined) return undefined;
      mapped = { kind: 'face', faceId, bodyVersion: receipt.to };
    } else {
      const edgeKey = receipt.edges === null ? mapped.edgeKey : receipt.edges.get(mapped.edgeKey);
      if (edgeKey === undefined) return undefined;
      mapped = { kind: 'edge', edgeKey, bodyVersion: receipt.to };
    }
  }
  return mapped && (mapped.kind === 'face' ? body.faces.has(mapped.faceId as FaceLocalId) : body.edges.has(mapped.edgeKey as EdgeKey)) ? mapped : undefined;
}
