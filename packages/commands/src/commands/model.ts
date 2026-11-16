// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { captureContainerOccurrence, componentizePart, isolateContainerOccurrence, type ContainerIdentityChange } from './groups';
import { copyPhysical } from './physicalCopy';
import { placeNativeFragment } from './nativePlacement';
import { physicalStretch } from './physicalStretch';
import { attachProfileCurves } from './profileCurves';
import { z } from 'zod';
import { ANGLE_TOL, meshBox, PushFormError, v3cross, v3len, v3sub } from '@pushform/core';
import type { Vec3 } from '@pushform/core';
import { defineCommand } from '../registry/Command';
import { bodyFromMesh } from '@pushform/model';
import type { DocumentDraft, Draft, EntityContainer, EntityRef } from '@pushform/model';
import type { Id, TagId } from '@pushform/core';
import { activeTagOpt, hostOf, kernelOf } from '../host/services';
import { draftContainerAt } from './context';
import type { PushPullResult } from '@pushform/kernel';
import type { Mat4 } from '@pushform/core';

/** cast: inside a transaction the container is a draft; Body and Draft<Body> differ only in tuple mutability. */
const asDraft = (c: EntityContainer): Draft<EntityContainer> => c as unknown as Draft<EntityContainer>;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** Add an axis-aligned box body (context-local coordinates) directly from a mesh (no kernel round trip); the model document API's add_box. */
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

/** Only trusted host code supplies normalized kernel components to these installation commands. */
const profileSolidParams = z.object({ result: z.custom<PushPullResult>(value => typeof value === 'object' && value !== null && Array.isArray((value as PushPullResult).components)),
  frame: z.array(z.number().finite()).length(16), sideDirection: vec3, smoothSides: z.boolean().default(false), curve: z.object({ points: z.array(vec3).min(3).max(512), normal: vec3, offset: vec3 }).optional() });
export type ProfileSolidParams = z.infer<typeof profileSolidParams>;
function installProfile(draft: DocumentDraft, path: readonly Id[], p: ProfileSolidParams, tag: {tagId?: TagId}): Id {
  const body = bodyFromMesh(draft,p.result.components[0]!.mesh,{container:asDraft(draftContainerAt(draft,path)),...tag});
  body.referenceFrame=p.frame as unknown as Mat4;
  if(p.smoothSides)for(const edge of body.edges.values()){
    const direction=v3sub(edge.polyline.at(-1)!,edge.polyline[0]!);
    if(v3len(v3cross(direction,p.sideDirection))<=ANGLE_TOL*v3len(direction)){edge.soft=true;edge.smooth=true;}
  }
  if(p.curve)attachProfileCurves(draft,body,p.curve);
  return body.id;
}
function validateProfileResult(result: PushPullResult): void {
  if(result.components.length!==1||!(result.components[0]!.props.volume>0))throw new PushFormError('kernel.invalidMesh','The profile must produce one nonempty solid.');
}
/** Install a context-local profile, retaining the existing drawing command's result. */
export const addProfileSolid = defineCommand({
  id:'model.addProfileSolid',title:'Draw Part',category:'internal',undoable:true,params:profileSolidParams,
  run(ctx,p){validateProfileResult(p.result);const host=hostOf(ctx);return host.edit('Draw Part',draft=>installProfile(draft,host.context.path,p,activeTagOpt(ctx))) as number;},
});
export interface ScopedProfileResult { ref: EntityRef & {kind:'body'}; isolated:boolean; changes:ContainerIdentityChange[] }
/** Install in a captured descendant without changing the live editing context. */
export const addPartProfile = defineCommand({
  id:'part.addProfileSolid',title:'Create Physical Part',category:'internal',undoable:true,
  params:profileSolidParams.extend({container:z.array(z.number().int().nonnegative()).max(64),isolate:z.boolean().default(true),componentName:z.string().trim().min(1).max(200).optional()}),
  run(ctx,p):ScopedProfileResult {
    validateProfileResult(p.result);const host=hostOf(ctx);captureContainerOccurrence(host,p.container,p.isolate);
    return host.edit('Create Physical Part',draft=>{
      const continuation=p.isolate?isolateContainerOccurrence(draft,p.container):{path:p.container as Id[],isolated:false,changes:[]};
      const id=installProfile(draft,continuation.path,p,activeTagOpt(ctx));
      const ref:EntityRef&{kind:'body'}={kind:'body',id,path:continuation.path};
      return{ref:p.componentName?componentizePart(draft,ref,p.componentName):ref,isolated:continuation.isolated,changes:continuation.changes};
    });
  },
});
export const modelCommands = [addBox, fromTriangles, deleteBody, kernelStats, addProfileSolid, addPartProfile, copyPhysical, placeNativeFragment, physicalStretch];
