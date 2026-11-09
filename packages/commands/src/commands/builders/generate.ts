// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { m4fromBasis, m4mul, m4rotationAxis, m4translation, v3dot } from '@pushform/core';
import type { Id, MeshData, MMat4, Vec3 } from '@pushform/core';
import { bodyFromMesh } from '@pushform/model';
import type { Body, Draft, DocumentState, EntityContainer, FaceRecord, Material } from '@pushform/model';
import { defineCommand } from '../../registry/Command';
import type { AnyCommand } from '../../registry/Command';
import { activeTagOpt, hostOf } from '../../host/services';
import { draftContainerAt } from '../context';
import { edgeAngleDeg } from '../edges';
import { createDefinition, newInstance, uniqueDefinitionName } from '../groups';
import { grainMapping } from '../materials';
import { meshLoftedPanel, meshPrism, meshStock } from './mesh';
import { materialKey } from './parts';
import type { BuilderPart, BuilderPlan } from './parts';

export interface BuilderGeneratedPart {
  readonly name: string;
  readonly id: number;
  readonly path: number[];
  readonly size?: Vec3;
  /** How many placements share this part's definition, when more than one does. */
  readonly copies?: number;
}
export interface BuilderGenerateResult {
  readonly instanceId: number;
  readonly definitionId: number;
  readonly name: string;
  readonly parts: BuilderGeneratedPart[];
}

export function builderPartMesh(part: BuilderPart): MeshData {
  const { shape } = part;
  if (shape.kind === 'lofted') return meshLoftedPanel(part.size[0], part.size[1], shape.rings);
  if (shape.kind === 'prism') return meshPrism(shape.outline, part.size[2], shape.holes);
  if (shape.kind === 'section') {
    const mesh = meshPrism(shape.outline, part.size[0]);
    const verts = new Float64Array(mesh.verts.length);
    // A cyclic swap of axes keeps the mesh's handedness: the profile's plane becomes y-z and its depth x.
    for (let i = 0; i < verts.length; i += 3) verts.set([mesh.verts[i + 2]!, mesh.verts[i]!, mesh.verts[i + 1]!], i);
    return { verts, tris: mesh.tris, faceId: mesh.faceId };
  }
  return meshStock(part.size, shape.cuts);
}

const GRAIN: Vec3 = [1, 0, 0];
/** Edges between facets of a round part this shallow are drawn smooth. */
const ROUND_EDGE_DEG = 20;
const FACE_TOL = 1e-6;

/** Run the texture's grain along the part's length, on the faces it shows; end grain keeps the default placement. */
function setGrain(face: FaceRecord | Draft<FaceRecord>, material: Material | undefined): void {
  const texture = material?.texture;
  if (!texture || texture.grain === 'none') return;
  const uv = grainMapping(face.basis as FaceRecord['basis'], face.plane.n as Vec3, GRAIN, texture.grain ?? 'width');
  if (uv) (face as FaceRecord).uv = uv;
}

/** Parts with this key make the same solid in the same materials, so they share one definition. */
const identity = (part: BuilderPart): string =>
  JSON.stringify([part.shape, part.size.map(s => Math.round(s * 1e6)), part.role, part.plusZRole ?? null, part.zeroFaceRole ?? null]);

/** What the names of parts sharing a definition have in common: "Left Stile" and "Right Stile" make "Stile". */
function sharedName(names: readonly string[]): string {
  const words = names[0]!.split(' ').filter(word => names.every(name => name.split(' ').includes(word)));
  return words.join(' ') || names[0]!;
}

const paramsSchema = z.object({
  plan: z.custom<BuilderPlan>(v => typeof v === 'object' && v !== null && 'parts' in v),
  materials: z.record(z.string(), z.number().int()),
});

const instanceInto = (container: Draft<EntityContainer> | EntityContainer, inst: { id: Id }): void => {
  (container.instances as unknown as Map<Id, typeof inst>).set(inst.id, inst);
  container.order.push(inst.id);
};

/** Generate a planned object in the open container: a group of named assemblies and parts, in one edit. */
export const builderGenerate = defineCommand({
  id: 'builder.generate',
  title: 'Generate',
  category: 'internal',
  params: paramsSchema,
  undoable: false,
  run(ctx, { plan, materials }): BuilderGenerateResult {
    const host = hostOf(ctx);
    const tag = activeTagOpt(ctx);
    const contextPath = [...host.context.path];
    let result: BuilderGenerateResult | null = null;
    host.edit(`Generate ${plan.name}`, (draft) => {
      const state = draft as unknown as DocumentState;
      const buildPlan = (current: BuilderPlan, into: Draft<EntityContainer> | EntityContainer, parentPath: number[]): BuilderGenerateResult => {
        const materialOf = (role: string): Material | undefined => {
          const spec = current.materials[role];
          const id = spec ? materials[materialKey(spec)] : undefined;
          return id === undefined ? undefined : state.materials.get(id as never);
        };
        const only = current.parts.length === 1 && !current.children?.length && current.parts[0]!.assembly === null ? current.parts[0]! : null;
        if (only) {
          // One part needs no group around it: the part's own group, named for the plan, is the object.
          const def = createDefinition(draft, { name: uniqueDefinitionName(state, current.name), isGroup: true });
          const material = materialOf(only.role);
          const body: Body = bodyFromMesh(draft, builderPartMesh(only), { container: def.entities as unknown as Draft<EntityContainer>, materialId: material?.id ?? null, regroupFaces: true, ...tag });
          const live = (def.entities as unknown as Draft<EntityContainer>).bodies.get(body.id)!;
          for (const face of live.faces.values()) setGrain(face, material);
          const outer = current.rotationDeg ? m4mul(m4translation(current.at), m4rotationAxis([0, 0, 1], (current.rotationDeg * Math.PI) / 180)) : m4translation(current.at);
          const inst = newInstance(draft, def.id, m4mul(outer, m4fromBasis(only.origin, only.x, only.y, only.z)), current.name);
          instanceInto(into, inst);
          return { instanceId: inst.id, definitionId: def.id, name: current.name, parts: [{ name: only.name, id: inst.id, path: [...parentPath, inst.id as number], size: only.size }] };
        }
        const root = createDefinition(draft, { name: uniqueDefinitionName(state, current.name), isGroup: true });
        const rootContainer = root.entities as unknown as Draft<EntityContainer>;
        const turn = current.rotationDeg ? m4rotationAxis([0, 0, 1], (current.rotationDeg * Math.PI) / 180) : null;
        const placed = newInstance(draft, root.id, turn ? m4mul(m4translation(current.at), turn) : m4translation(current.at), current.name);
        instanceInto(into, placed);
        const here = [...parentPath, placed.id as number];

        // Each assembly's origin is the low corner of its parts, so moving or swinging it starts from its own corner.
        const assemblies = new Map<string, { container: Draft<EntityContainer>; id: Id; origin: Vec3 }>();
        const corner = (name: string): Vec3 => {
          const points = current.parts.filter(p => p.assembly === name).flatMap(p => [p.origin, partFar(p)]);
          return [0, 1, 2].map(i => Math.min(...points.map(v => v[i]!))) as unknown as Vec3;
        };
        const assemblyFor = (name: string) => {
          let found = assemblies.get(name);
          if (!found) {
            const def = createDefinition(draft, { name: uniqueDefinitionName(state, name), isGroup: true });
            const origin = corner(name);
            const inst = newInstance(draft, def.id, m4translation(origin), name);
            instanceInto(rootContainer, inst);
            found = { container: def.entities as unknown as Draft<EntityContainer>, id: inst.id, origin };
            assemblies.set(name, found);
          }
          return found;
        };

        const groups = new Map<string, BuilderPart[]>();
        for (const part of current.parts) {
          const key = identity(part);
          groups.set(key, [...(groups.get(key) ?? []), part]);
        }
        const definitions = new Map<string, ReturnType<typeof createDefinition>>();
        const definitionFor = (part: BuilderPart): { def: ReturnType<typeof createDefinition>; copies: number } => {
          const key = identity(part), sharing = groups.get(key)!;
          const made = definitions.get(key);
          if (made) return { def: made, copies: sharing.length };
          const def = createDefinition(draft, {
            name: uniqueDefinitionName(state, sharing.length > 1 ? sharedName(sharing.map(p => p.name)) : part.name),
            isGroup: sharing.length === 1,
          });
          definitions.set(key, def);
          const material = materialOf(part.role);
          const body: Body = bodyFromMesh(draft, builderPartMesh(part), {
            container: def.entities as unknown as Draft<EntityContainer>,
            materialId: material?.id ?? null,
            regroupFaces: true,
            ...tag,
          });
          const live = (def.entities as unknown as Draft<EntityContainer>).bodies.get(body.id)!;
          for (const face of live.faces.values()) {
            const faceRole = part.plusZRole !== undefined && v3dot(face.plane.n as Vec3, [0, 0, 1]) > 0.5 && Math.abs(-face.plane.d - part.size[2]) < FACE_TOL ? part.plusZRole
              : part.zeroFaceRole !== undefined && face.plane.n[2] < -0.5 && Math.abs(face.plane.d) < FACE_TOL ? part.zeroFaceRole
                : undefined;
            const shown = faceRole === undefined ? material : materialOf(faceRole);
            if (faceRole !== undefined && shown) face.frontMaterialId = shown.id;
            setGrain(face, shown);
          }
          if ((part.shape.kind === 'prism' && part.shape.round) || part.shape.kind === 'section')
            for (const e of live.edges.values()) {
              const deg = edgeAngleDeg(live as unknown as Body, e as never);
              if (deg !== null && deg <= ROUND_EDGE_DEG) { e.soft = true; e.smooth = true; }
            }
          return { def, copies: sharing.length };
        };

        const parts: BuilderGeneratedPart[] = [];
        for (const part of current.parts) {
          const { def, copies } = definitionFor(part);
          const assembly = part.assembly === null ? null : assemblyFor(part.assembly);
          const placement: MMat4 = m4fromBasis(part.origin, part.x, part.y, part.z);
          const local = assembly ? m4mul(m4translation([-assembly.origin[0], -assembly.origin[1], -assembly.origin[2]]), placement) : placement;
          const inst = newInstance(draft, def.id, local, part.name);
          instanceInto(assembly ? assembly.container : rootContainer, inst);
          parts.push({
            name: part.assembly ? `${part.assembly}: ${part.name}` : part.name, id: inst.id,
            path: [...here, ...(assembly ? [assembly.id as number] : []), inst.id as number], size: part.size,
            ...(copies > 1 ? { copies } : {}),
          });
        }
        for (const child of current.children ?? []) {
          const made = buildPlan(child, rootContainer, here);
          parts.push({ name: child.name, id: made.instanceId, path: [...here, made.instanceId] });
        }
        return { instanceId: placed.id, definitionId: root.id, name: current.name, parts };
      };

      result = buildPlan(plan, draftContainerAt(draft, contextPath), contextPath);
    });
    return result!;
  },
});

function partFar(p: BuilderPart): Vec3 {
  return [0, 1, 2].map(i => p.origin[i]! + p.x[i]! * p.size[0] + p.y[i]! * p.size[1] + p.z[i]! * p.size[2]) as unknown as Vec3;
}

export const builderCommands: readonly AnyCommand[] = [builderGenerate];
