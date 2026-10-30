// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { meshBox, PushFormError } from '@pushform/core';
import type { Vec3 } from '@pushform/core';
import { defineCommand } from '../registry/Command';
import { bodyFromMesh } from '@pushform/model';
import type { Draft, EntityContainer } from '@pushform/model';
import type { Id } from '@pushform/core';
import { activeTagOpt, hostOf, kernelOf } from '../host/services';
import { draftContainerAt } from './context';

/** cast: inside a transaction the container is a draft; Body and Draft<Body> differ only in tuple mutability. */
const asDraft = (c: EntityContainer): Draft<EntityContainer> => c as unknown as Draft<EntityContainer>;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** Debug/M0: add an axis-aligned box body (context-local coordinates) directly from a mesh (no kernel round trip). */
export const addBox = defineCommand({
  id: 'model.addBox',
  title: 'Add Box',
  category: 'internal',
  params: z.object({ min: vec3.default([0, 0, 0]), max: vec3.default([1, 1, 1]) }),
  undoable: true,
  run(ctx, { min, max }) {
    const host = hostOf(ctx);
    const path = host.context.path;
    return host.edit('Add Box', (draft) => {
      const body = bodyFromMesh(draft, meshBox(min as Vec3, max as Vec3), { container: asDraft(draftContainerAt(draft, path)), ...activeTagOpt(ctx) });
      return body.id as number;
    });
  },
});

/**
 * Build a body from raw triangles through the kernel (validates manifoldness, groups faces).
 * Async: the kernel call happens first, then the document edit is recorded as one undo step.
 */
export const fromTriangles = defineCommand({
  id: 'model.fromTriangles',
  title: 'Body From Triangles',
  category: 'internal',
  params: z.object({
    verts: z.array(z.number()),
    tris: z.array(z.number().int().nonnegative()),
    faceId: z.array(z.number().int().nonnegative()).optional(),
  }),
  undoable: false,
  async run(ctx, p) {
    const host = hostOf(ctx);
    const kernel = kernelOf(ctx);
    const faceId = p.faceId ? new Uint32Array(p.faceId) : new Uint32Array(p.tris.length / 3);
    const res = await kernel.fromTriangles({
      mesh: { verts: new Float64Array(p.verts), tris: new Uint32Array(p.tris), faceId, runId: 0 },
      nextFaceId: 0,
    });
    if (res.status !== 'NoError') throw new PushFormError('kernel.invalidMesh', `Mesh is not a valid solid: ${res.status}`);
    const ids: number[] = [];
    const path = host.context.path;
    host.transact('Body From Triangles', () =>
      host.edit('Body From Triangles', (draft) => {
        const container = asDraft(draftContainerAt(draft, path));
        for (const c of res.components) {
          const body = bodyFromMesh(draft, c.mesh, { container });
          ids.push(body.id as number);
        }
      }),
    );
    return ids;
  },
});

export const deleteBody = defineCommand({
  id: 'model.deleteBody',
  title: 'Delete Body',
  category: 'internal',
  params: z.object({ id: z.number().int() }),
  undoable: true,
  run(ctx, { id }) {
    const host = hostOf(ctx);
    const path = host.context.path;
    return host.edit('Delete Body', (draft) => {
      const root = draftContainerAt(draft, path);
      const ok = root.bodies.delete(id as Id);
      root.order = root.order.filter((x) => x !== id);
      return ok;
    });
  },
});

export const kernelStats = defineCommand({
  id: 'kernel.stats',
  title: 'Kernel Stats',
  category: 'internal',
  params: z.object({}),
  undoable: false,
  run(ctx) {
    return kernelOf(ctx).stats();
  },
});

export const modelCommands = [addBox, fromTriangles, deleteBody, kernelStats];
