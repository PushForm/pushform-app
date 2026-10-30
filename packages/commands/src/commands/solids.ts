// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { FaceLocalId, Id, MeshData } from '@pushform/core';
import { PushFormError } from '@pushform/core';
import type { BooleanResult, KernelClient, KernelComponent } from '@pushform/kernel';
import { applyKernelResult, bodyFromMesh } from '@pushform/model';
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
 * - outerShell: iterated union of n bodies → the first survives
 * Each is one undo entry; the kernel runs first. "Solid" = `body.valid`.
 */

export type SolidMode = 'union' | 'subtract' | 'trim' | 'intersect' | 'split' | 'outerShell';
export const SOLID_MODES: readonly SolidMode[] = ['union', 'subtract', 'trim', 'intersect', 'split', 'outerShell'];

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

/** Shared body of union / intersect / subtract / trim: `keep` is modified by `op` with `other`; `other` is deleted when `deleteOther`. */
async function pairOp(host: DocumentHost, kernel: KernelClient, label: string, op: 'add' | 'subtract' | 'intersect' | 'trim', keep: Body, other: Body, deleteOther: boolean): Promise<SolidsApplyResult> {
  const res = await runBoolean(kernel, op, keep, other);
  return host.transact(label, () =>
    host.edit(label, (draft) => {
      const root = draftRoot(draft, host);
      const k = assertUnchanged(root, keep, label);
      if (deleteOther) assertUnchanged(root, other, label);
      const bodyIds = applyComponents(draft, root, k, res.components, res.aRunId, res.nextFaceId, [{ runId: res.bRunId, body: other }]);
      const deleted: number[] = bodyIds.includes(k.id) ? [] : [k.id];
      if (deleteOther) {
        removeBody(root, other.id);
        deleted.push(other.id);
      }
      return { bodyIds, deleted };
    }),
  );
}

export const solidsUnion = defineCommand({
  id: 'solids.union',
  title: 'Union',
  category: 'edit',
  params: pairSchema,
  undoable: false,
  async run(ctx, p): Promise<SolidsApplyResult> {
    const host = hostOf(ctx);
    const a = solidOf(host, p.a, 'Union');
    const b = solidOf(host, p.b, 'Union');
    return pairOp(host, kernelOf(ctx), 'Union', 'add', a, b, true);
  },
});

/** Subtract: `a` is the cutter (deleted), `b` is cut. */
export const solidsSubtract = defineCommand({
  id: 'solids.subtract',
  title: 'Subtract',
  category: 'edit',
  params: pairSchema,
  undoable: false,
  async run(ctx, p): Promise<SolidsApplyResult> {
    const host = hostOf(ctx);
    const cutter = solidOf(host, p.a, 'Subtract');
    const target = solidOf(host, p.b, 'Subtract');
    return pairOp(host, kernelOf(ctx), 'Subtract', 'subtract', target, cutter, true);
  },
});

/** Trim: like Subtract but the cutter `a` stays. */
export const solidsTrim = defineCommand({
  id: 'solids.trim',
  title: 'Trim',
  category: 'edit',
  params: pairSchema,
  undoable: false,
  async run(ctx, p): Promise<SolidsApplyResult> {
    const host = hostOf(ctx);
    const cutter = solidOf(host, p.a, 'Trim');
    const target = solidOf(host, p.b, 'Trim');
    return pairOp(host, kernelOf(ctx), 'Trim', 'trim', target, cutter, false);
  },
});

export const solidsIntersect = defineCommand({
  id: 'solids.intersect',
  title: 'Intersect',
  category: 'edit',
  params: pairSchema,
  undoable: false,
  async run(ctx, p): Promise<SolidsApplyResult> {
    const host = hostOf(ctx);
    const a = solidOf(host, p.a, 'Intersect');
    const b = solidOf(host, p.b, 'Intersect');
    return pairOp(host, kernelOf(ctx), 'Intersect', 'intersect', a, b, true);
  },
});

/** Split: both bodies are replaced by a ∩ b, a − b and b − a (every connected piece its own body). */
export const solidsSplit = defineCommand({
  id: 'solids.split',
  title: 'Split',
  category: 'edit',
  params: pairSchema,
  undoable: false,
  async run(ctx, p): Promise<SolidsApplyResult> {
    const host = hostOf(ctx);
    const kernel = kernelOf(ctx);
    const a = solidOf(host, p.a, 'Split');
    const b = solidOf(host, p.b, 'Split');
    const split = await runBoolean(kernel, 'split', a, b); // components = a ∩ b, secondary = a − b
    const bMinusA = await runBoolean(kernel, 'subtract', b, a);
    return host.transact('Split', () =>
      host.edit('Split', (draft) => {
        const root = draftRoot(draft, host);
        assertUnchanged(root, a, 'Split');
        assertUnchanged(root, b, 'Split');
        const bodyIds: number[] = [];
        for (const c of split.components) bodyIds.push(bodyFromComponent(draft, root, c, a, split.aRunId).id);
        for (const c of split.secondary) bodyIds.push(bodyFromComponent(draft, root, c, a, split.aRunId).id);
        for (const c of bMinusA.components) bodyIds.push(bodyFromComponent(draft, root, c, b, bMinusA.aRunId).id);
        removeBody(root, a.id);
        removeBody(root, b.id);
        return { bodyIds, deleted: [a.id, b.id] };
      }),
    );
  },
});

/** Outer Shell: iterated union of all given bodies; the first survives, the others are deleted. */
export const solidsOuterShell = defineCommand({
  id: 'solids.outerShell',
  title: 'Outer Shell',
  category: 'edit',
  params: z.object({ bodies: z.array(BodyRefSchema).min(2) }),
  undoable: false,
  async run(ctx, p): Promise<SolidsApplyResult> {
    const host = hostOf(ctx);
    const kernel = kernelOf(ctx);
    const bodies = p.bodies.map((r) => solidOf(host, r, 'Outer Shell'));
    if (new Set(bodies.map((b) => b.id)).size !== bodies.length) throw new PushFormError('solids.target', 'Outer Shell: the same body was given twice');
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
          await kernel.ensureBody(temp.bodyId, temp.version, main.mesh);
          temps.push(temp);
          cur = temp;
        }
      }
    } finally {
      for (const t of temps) void kernel.release(t.bodyId, t.version).catch(() => undefined);
    }
    return host.transact('Outer Shell', () =>
      host.edit('Outer Shell', (draft) => {
        const root = draftRoot(draft, host);
        const f = assertUnchanged(root, first, 'Outer Shell');
        for (const b of bodies.slice(1)) assertUnchanged(root, b, 'Outer Shell');
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

export const solidCommands: readonly AnyCommand[] = [solidsUnion, solidsSubtract, solidsTrim, solidsIntersect, solidsSplit, solidsOuterShell];

/** Command id for a Solid Tools mode. */
export const solidCommandId = (mode: SolidMode): string => `solids.${mode}`;
