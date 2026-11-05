// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { CurveId, FaceLocalId, Id, MeshData, SurfaceId } from '@pushform/core';
import { PushFormError } from '@pushform/core';
import type { BooleanResult, KernelClient, KernelComponent } from '@pushform/kernel';
import { allocId, applyKernelResult, bodyFromMesh } from '@pushform/model';
import type { Body, DocumentDraft, DocumentState, EntityContainer, Draft, KernelFaceOrigin, KernelResult } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf, kernelOf } from '../host/services';
import type { DocumentHost } from '../host/DocumentHost';
import { draftContainerAt, requireContextPath } from './context';
import { rootContainerOf } from './offset';

/**
 * Solid Tools over bodies (always available: every body is a Manifold solid).
 * - union: a ∪ b → a survives, b deleted
 * - subtract: b − a → a (the cutter) deleted, b modified
 * - trim: b − a → cutter a kept, b modified
 * - intersect: a ∩ b → a survives, b deleted
 * - split: a ∩ b, a − b, b − a → both replaced by every piece
 * Each is one undo entry; the kernel runs first. "Solid" = `body.valid`.
 */

export type SolidMode = 'union' | 'subtract' | 'trim' | 'intersect' | 'split';
export const SOLID_MODES: readonly SolidMode[] = ['union', 'subtract', 'trim', 'intersect', 'split'];

const pathSchema = z.array(z.number().int().nonnegative()).default([]);
export const BodyRefSchema = z.object({ kind: z.literal('body'), path: pathSchema, id: z.number().int().nonnegative() });
export type BodyRefParam = z.infer<typeof BodyRefSchema>;
const pairSchema = z.object({ a: BodyRefSchema, b: BodyRefSchema });

export interface SolidsApplyResult {
  /** Bodies that exist after the operation and were created or modified by it. */
  bodyIds: number[];
  /** Bodies deleted by the operation. */
  deleted: number[];
}

/** Temporary kernel body ids for intermediate results (never document ids: those are < 2^31). */
const TEMP_BODY_BASE = 0x7f000000;
let tempCounter = 0;

function solidOf(host: DocumentHost, ref: BodyRefParam, role: string): Body {
  const state: DocumentState = host.doc.state;
  requireContextPath(host, ref.path, `${role}: body ${ref.id}`);
  const root = rootContainerOf(state, ref.path);
  const body = root.bodies.get(ref.id as Id);
  if (!body) throw new PushFormError('solids.target', `${role}: body ${ref.id} not found`);
  if (!body.valid) throw new PushFormError('solids.notSolid', `${role}: body ${ref.id} is not a solid`);
  return body;
}

const toMesh = (c: KernelComponent): MeshData => ({ verts: c.mesh.verts, tris: c.mesh.tris, faceId: c.mesh.faceId });
const asDraft = (c: EntityContainer): Draft<EntityContainer> => c as unknown as Draft<EntityContainer>;

function toKernelResult(c: KernelComponent, selfRunId: number, foreign: ReadonlyArray<{ runId: number; body: Body }> = []): KernelResult {
  // cast: the wire carries plain numbers where the model uses branded FaceLocalIds
  return { mesh: toMesh(c), faceOrigin: c.faceOrigin as unknown as Map<FaceLocalId, KernelFaceOrigin[]>, selfRunId, props: c.props, foreign };
}

/** New body from a component, copying face attributes from `source` faces it originated from (by run + face id). */
function bodyFromComponent(draft: DocumentDraft, root: EntityContainer, c: KernelComponent, source: Body, sourceRunId: number): Body {
  const body = bodyFromMesh(draft, toMesh(c), { container: asDraft(root), tagId: source.tagId, materialId: source.materialId });
  for (const [fid, rec] of body.faces) {
    const origin = (c.faceOrigin.get(fid) ?? []).find((o) => o.runId === sourceRunId && source.faces.has(o.faceId as FaceLocalId));
    const src = origin ? source.faces.get(origin.faceId as FaceLocalId) : undefined;
    if (!src) continue;
    rec.frontMaterialId = src.frontMaterialId;
    rec.backMaterialId = src.backMaterialId;
    rec.uv = src.uv;
    if (src.uvBack) rec.uvBack = src.uvBack;
    rec.tagId = src.tagId;
  }
  return body;
}

function removeBody(root: EntityContainer, id: Id): void {
  root.bodies.delete(id);
  root.order = root.order.filter((x) => x !== id);
}

/** Trim keeps its cutter, so copied curve/surface records need distinct persistent IDs. */
function reidentifyCutterMetadata(draft: DocumentDraft, body: Body, cutter: Body): void {
  for (const cid of cutter.curves.keys()) {
    const curve = body.curves.get(cid);
    if (!curve) continue;
    const id = allocId<CurveId>(draft);
    body.curves.delete(cid);
    body.curves.set(id, { ...curve, id });
    for (const edge of body.edges.values()) if (edge.curveId === cid) edge.curveId = id;
    for (const surface of body.surfaces.values()) if (surface.curveId === cid) surface.curveId = id;
  }
  for (const sid of cutter.surfaces.keys()) {
    const surface = body.surfaces.get(sid);
    if (!surface) continue;
    const id = allocId<SurfaceId>(draft);
    body.surfaces.delete(sid);
    body.surfaces.set(id, { ...surface, id });
    for (const face of body.faces.values()) if (face.surfaceId === sid) face.surfaceId = id;
  }
}

function draftRoot(draft: DocumentDraft, host: DocumentHost): EntityContainer {
  return draftContainerAt(draft, host.context.path);
}

function assertUnchanged(root: EntityContainer, body: Body, label: string): Body {
  const cur = root.bodies.get(body.id);
  if (!cur || cur.version !== body.version) throw new PushFormError('solids.stale', `A body changed before ${label} could be applied`);
  return cur;
}

/**
 * Replace `survivor` with the first component (or delete it when nothing is left) and create a
 * body for every extra component. Returns the ids that exist afterwards.
 */
function applyComponents(
  draft: DocumentDraft,
  root: EntityContainer,
  survivor: Body,
  components: readonly KernelComponent[],
  selfRunId: number,
  nextFaceId: number,
  foreign: ReadonlyArray<{ runId: number; body: Body }> = [],
): number[] {
  const [first, ...extras] = components;
  const ids: number[] = [];
  if (!first) {
    removeBody(root, survivor.id);
    return ids;
  }
  const updated = applyKernelResult(draft, survivor.id, toKernelResult(first, selfRunId, foreign));
  updated.nextFaceId = Math.max(updated.nextFaceId, nextFaceId);
  ids.push(updated.id);
  for (const c of extras) ids.push(bodyFromComponent(draft, root, c, survivor, selfRunId).id);
  return ids;
}

async function runBoolean(kernel: KernelClient, op: 'add' | 'subtract' | 'intersect' | 'split' | 'trim', a: Body, b: Body): Promise<BooleanResult> {
  await kernel.ensureBody(a.id, a.version, a.mesh);
  await kernel.ensureBody(b.id, b.version, b.mesh);
  return kernel.boolean({ op, a: { bodyId: a.id, version: a.version }, b: { bodyId: b.id, version: b.version }, nextFaceId: a.nextFaceId });
}

/** The boolean modes that take two bodies. */
export type SolidsPairMode = 'union' | 'subtract' | 'trim' | 'intersect' | 'split';

/**
 * The kernel step of a two-body Solid Tools command, computed before the document changes. Passing it back to the
 * command as `precomputed` commits it without running the kernel again, so a caller can await the kernel outside the
 * edit and commit synchronously (atomic batches do this). The commit re-checks that neither body changed meanwhile.
 */
export type SolidsKernelWork =
  | { readonly mode: 'union' | 'subtract' | 'trim' | 'intersect'; readonly keep: Body; readonly other: Body; readonly result: BooleanResult }
  | { readonly mode: 'split'; readonly a: Body; readonly b: Body; readonly split: BooleanResult; readonly bMinusA: BooleanResult };

const KERNEL_OP = { union: 'add', subtract: 'subtract', trim: 'trim', intersect: 'intersect' } as const;
const TITLE: Record<SolidsPairMode, string> = { union: 'Union', subtract: 'Subtract', trim: 'Trim', intersect: 'Intersect', split: 'Split' };

const isSolidsWork = (v: unknown): v is SolidsKernelWork =>
  typeof v === 'object' && v !== null && typeof (v as { mode?: unknown }).mode === 'string';

/**
 * Validate the two bodies and run the kernel for `mode`. For subtract and trim `a` is the cutter and `b` the body
 * cut; for union and intersect `a` survives. Reads the document only.
 */
export async function runSolidsKernel(host: DocumentHost, kernel: KernelClient, mode: SolidsPairMode, p: { a: BodyRefParam; b: BodyRefParam }): Promise<SolidsKernelWork> {
  const title = TITLE[mode];
  const a = solidOf(host, p.a, title);
  const b = solidOf(host, p.b, title);
  if (a.id === b.id) throw new PushFormError('solids.target', `${title}: the same body was given twice`);
  if (mode === 'split') {
    const split = await runBoolean(kernel, 'split', a, b); // components = a ∩ b, secondary = a − b
    const bMinusA = await runBoolean(kernel, 'subtract', b, a);
    return { mode, a, b, split, bMinusA };
  }
  // subtract and trim modify the body cut (b) with the cutter (a); union and intersect keep a
  const [keep, other] = mode === 'subtract' || mode === 'trim' ? [b, a] : [a, b];
  return { mode, keep, other, result: await runBoolean(kernel, KERNEL_OP[mode], keep, other) };
}

/** Commit a kernel step in one transaction; throws `solids.stale` when a body changed since it ran. */
export function commitSolids(host: DocumentHost, work: SolidsKernelWork): SolidsApplyResult {
  const label = TITLE[work.mode];
  if (work.mode === 'split') {
    const { a, b, split, bMinusA } = work;
    return host.transact(label, () =>
      host.edit(label, (draft) => {
        const root = draftRoot(draft, host);
        assertUnchanged(root, a, label);
        assertUnchanged(root, b, label);
        const bodyIds: number[] = [];
        for (const c of split.components) bodyIds.push(bodyFromComponent(draft, root, c, a, split.aRunId).id);
        for (const c of split.secondary) bodyIds.push(bodyFromComponent(draft, root, c, a, split.aRunId).id);
        for (const c of bMinusA.components) bodyIds.push(bodyFromComponent(draft, root, c, b, bMinusA.aRunId).id);
        removeBody(root, a.id);
        removeBody(root, b.id);
        return { bodyIds, deleted: [a.id, b.id] };
      }),
    );
  }
  const { keep, other, result: res } = work;
  const deleteOther = work.mode !== 'trim';
  return host.transact(label, () =>
    host.edit(label, (draft) => {
      const root = draftRoot(draft, host);
      const k = assertUnchanged(root, keep, label);
      if (deleteOther) assertUnchanged(root, other, label);
      const bodyIds = applyComponents(draft, root, k, res.components, res.aRunId, res.nextFaceId, [{ runId: res.bRunId, body: other }]);
      if (!deleteOther) {
        for (const id of bodyIds) reidentifyCutterMetadata(draft, root.bodies.get(id as Id)!, other);
      }
      const deleted: number[] = bodyIds.includes(k.id) ? [] : [k.id];
      if (deleteOther) {
        removeBody(root, other.id);
        deleted.push(other.id);
      }
      return { bodyIds, deleted };
    }),
  );
}

const pairParams = pairSchema.extend({
  /** A kernel step from `runSolidsKernel` for exactly this mode and these bodies. */
  precomputed: z.custom<SolidsKernelWork>(isSolidsWork).optional(),
});

function pairCommand(mode: SolidsPairMode) {
  return defineCommand({
    id: `solids.${mode}`,
    title: TITLE[mode],
    category: 'edit',
    params: pairParams,
    undoable: false,
    async run(ctx, p): Promise<SolidsApplyResult> {
      const host = hostOf(ctx);
      if (p.precomputed && p.precomputed.mode !== mode) throw new PushFormError('solids.target', `${TITLE[mode]}: the precomputed result is for ${p.precomputed.mode}`);
      const work = p.precomputed ?? (await runSolidsKernel(host, kernelOf(ctx), mode, p));
      return commitSolids(host, work);
    },
  });
}

/** Union: a ∪ b; `a` survives and `b` is deleted. */
const solidsUnionPair = pairCommand('union');
/** Subtract: `a` is the cutter (deleted), `b` is cut. */
export const solidsSubtract = pairCommand('subtract');
/** Trim: like Subtract but the cutter `a` stays. */
export const solidsTrim = pairCommand('trim');
/** Intersect: a ∩ b; `a` survives and `b` is deleted. */
export const solidsIntersect = pairCommand('intersect');
/** Split: both bodies are replaced by a ∩ b, a − b and b − a (every connected piece its own body). */
export const solidsSplit = pairCommand('split');

/** Pack disconnected intermediate components into one kernel input without dropping any solids. */
function combinedMesh(components: readonly KernelComponent[]): MeshData {
  const verts = new Float64Array(components.reduce((n, c) => n + c.mesh.verts.length, 0));
  const tris = new Uint32Array(components.reduce((n, c) => n + c.mesh.tris.length, 0));
  const faceId = new Uint32Array(tris.length / 3);
  let vertexOffset = 0, triangleOffset = 0;
  for (const { mesh } of components) {
    verts.set(mesh.verts, vertexOffset);
    for (let i = 0; i < mesh.tris.length; i++) tris[triangleOffset + i] = mesh.tris[i]! + vertexOffset / 3;
    faceId.set(mesh.faceId, triangleOffset / 3);
    vertexOffset += mesh.verts.length;
    triangleOffset += mesh.tris.length;
  }
  return { verts, tris, faceId };
}

/** Union: iterated union of all given bodies; the first survives, the others are deleted. */
export const solidsUnion = defineCommand({
  id: 'solids.union',
  title: 'Union',
  category: 'edit',
  params: z.union([z.object({ bodies: z.array(BodyRefSchema).min(2) }), pairParams]),
  undoable: false,
  async run(ctx, p): Promise<SolidsApplyResult> {
    if (!('bodies' in p)) return solidsUnionPair.run(ctx, p) as Promise<SolidsApplyResult>;
    if (p.bodies.length === 2) return solidsUnionPair.run(ctx, { a: p.bodies[0]!, b: p.bodies[1]! }) as Promise<SolidsApplyResult>;
    const host = hostOf(ctx);
    const kernel = kernelOf(ctx);
    const bodies = p.bodies.map((r) => solidOf(host, r, 'Union'));
    if (new Set(bodies.map((b) => b.id)).size !== bodies.length) throw new PushFormError('solids.target', 'Union: the same body was given twice');
    const first = bodies[0]!;
    for (const b of bodies) await kernel.ensureBody(b.id, b.version, b.mesh);
    let cur = { bodyId: first.id as number, version: first.version };
    let nextFaceId = first.nextFaceId;
    let components: KernelComponent[] = [];
    let selfRunId = 0;
    const temps: { bodyId: number; version: number }[] = [];
    try {
      for (let i = 1; i < bodies.length; i++) {
        const b = bodies[i]!;
        const res = await kernel.boolean({ op: 'add', a: cur, b: { bodyId: b.id, version: b.version }, nextFaceId });
        nextFaceId = res.nextFaceId;
        selfRunId = res.aRunId;
        components = res.components;
        const main = components[0];
        if (!main) break;
        if (i + 1 < bodies.length) {
          const temp = { bodyId: TEMP_BODY_BASE + (tempCounter++ % 0xffff), version: i };
          await kernel.ensureBody(temp.bodyId, temp.version, combinedMesh(components));
          temps.push(temp);
          cur = temp;
        }
      }
    } finally {
      for (const t of temps) void kernel.release(t.bodyId, t.version).catch(() => undefined);
    }
    return host.transact('Union', () =>
      host.edit('Union', (draft) => {
        const root = draftRoot(draft, host);
        const f = assertUnchanged(root, first, 'Union');
        for (const b of bodies.slice(1)) assertUnchanged(root, b, 'Union');
        const bodyIds = applyComponents(draft, root, f, components, selfRunId, nextFaceId);
        const deleted: number[] = bodyIds.includes(f.id) ? [] : [f.id];
        for (const b of bodies.slice(1)) {
          removeBody(root, b.id);
          deleted.push(b.id);
        }
        return { bodyIds, deleted };
      }),
    );
  },
});

export const solidCommands: readonly AnyCommand[] = [solidsUnion, solidsSubtract, solidsTrim, solidsIntersect, solidsSplit];

/** Command id for a Solid Tools mode. */
export const solidCommandId = (mode: SolidMode): string => `solids.${mode}`;
