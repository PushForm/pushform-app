// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { m4fromBasis, m4mul, m4translation, v3dot } from '@pushform/core';
import type { DefId, Id, MeshData, MMat4, Vec3 } from '@pushform/core';
import { bodyFromMesh } from '@pushform/model';
import type { Body, Draft, DocumentState, EntityContainer, FaceRecord, Material } from '@pushform/model';
import { defineCommand } from '../../registry/Command';
import type { AnyCommand } from '../../registry/Command';
import { activeTagOpt, hostOf } from '../../host/services';
import { draftContainerAt } from '../context';
import { createDefinition, newInstance, uniqueDefinitionName } from '../groups';
import { grainMapping } from '../materials';
import { meshLoftedPanel, meshStock } from './mesh';
import type { CabinetPart, CabinetPlan } from './plan';

export interface CabinetGeneratedPart {
  readonly name: string;
  readonly id: number;
  readonly path: number[];
  readonly size: Vec3;
}
export interface CabinetGenerateResult {
  readonly instanceId: number;
  readonly definitionId: number;
  readonly name: string;
  readonly parts: CabinetGeneratedPart[];
}

export function cabinetPartMesh(part: CabinetPart): MeshData {
  return part.shape.kind === 'lofted' ? meshLoftedPanel(part.size[0], part.size[1], part.shape.rings) : meshStock(part.size, part.shape.cuts);
}

const GRAIN: Vec3 = [1, 0, 0];

/** Run the texture's grain along the part's length, on the faces it shows; end grain keeps the default placement. */
function setGrain(face: FaceRecord | Draft<FaceRecord>, material: Material | undefined): void {
  const texture = material?.texture;
  if (!texture || texture.grain === 'none') return;
  const uv = grainMapping(face.basis as FaceRecord['basis'], face.plane.n as Vec3, GRAIN, texture.grain ?? 'width');
  if (uv) (face as FaceRecord).uv = uv;
}

const paramsSchema = z.object({
  plan: z.custom<CabinetPlan>(v => typeof v === 'object' && v !== null && 'parts' in v),
  materials: z.object({ box: z.number().int(), show: z.number().int() }),
});

/** Build a planned cabinet in the open container: a group of named assemblies and parts, in one edit. */
export const cabinetGenerate = defineCommand({
  id: 'cabinet.generate',
  title: 'Generate Cabinet',
  category: 'internal',
  params: paramsSchema,
  undoable: false,
  run(ctx, { plan, materials }): CabinetGenerateResult {
    const host = hostOf(ctx);
    const tag = activeTagOpt(ctx);
    const contextPath = [...host.context.path];
    let result: CabinetGenerateResult | null = null;
    host.edit(`Generate ${plan.name}`, (draft) => {
      const state = draft as unknown as DocumentState;
      const materialOf = (role: CabinetPart['role']): Material | undefined => state.materials.get((role === 'box' ? materials.box : materials.show) as never);
      const cabinet = createDefinition(draft, { name: uniqueDefinitionName(state, plan.name), isGroup: true });
      const cabinetContainer = cabinet.entities as unknown as Draft<EntityContainer>;
      const placed = newInstance(draft, cabinet.id, m4translation(plan.at), plan.name);
      const into = draftContainerAt(draft, contextPath);
      into.instances.set(placed.id, placed);
      into.order.push(placed.id);

      // Each assembly's origin is the low corner of its parts, so moving or swinging it starts from its own corner.
      const assemblies = new Map<string, { container: Draft<EntityContainer>; id: Id; origin: Vec3 }>();
      const corner = (name: string): Vec3 => {
        const lows = plan.parts.filter(p => p.assembly === name).flatMap(p => [p.origin, partFar(p)]);
        return [0, 1, 2].map(i => Math.min(...lows.map(v => v[i]!))) as unknown as Vec3;
      };
      const assemblyFor = (name: string) => {
        let found = assemblies.get(name);
        if (!found) {
          const def = createDefinition(draft, { name: uniqueDefinitionName(state, name), isGroup: true });
          const origin = corner(name);
          const inst = newInstance(draft, def.id, m4translation(origin), name);
          (cabinetContainer.instances as unknown as Map<Id, typeof inst>).set(inst.id, inst);
          cabinetContainer.order.push(inst.id);
          found = { container: def.entities as unknown as Draft<EntityContainer>, id: inst.id, origin };
          assemblies.set(name, found);
        }
        return found;
      };

      const parts: CabinetGeneratedPart[] = [];
      for (const part of plan.parts) {
        const def = createDefinition(draft, { name: uniqueDefinitionName(state, part.name), isGroup: false });
        const material = materialOf(part.role);
        const body: Body = bodyFromMesh(draft, cabinetPartMesh(part), {
          container: def.entities as unknown as Draft<EntityContainer>,
          materialId: material?.id ?? null,
          regroupFaces: true,
          ...tag,
        });
        const live = (def.entities as unknown as Draft<EntityContainer>).bodies.get(body.id)!;
        const show = materialOf('show');
        for (const face of live.faces.values()) {
          const outside = part.finishedOutside && v3dot(face.plane.n as Vec3, [0, 0, 1]) > 0.5 && Math.abs(-face.plane.d - part.size[2]) < 1e-6;
          if (outside && show) face.frontMaterialId = show.id;
          setGrain(face, outside ? show : material);
        }
        const assembly = part.assembly === null ? null : assemblyFor(part.assembly);
        const placement: MMat4 = m4fromBasis(part.origin, part.x, part.y, part.z);
        const local = assembly ? m4mul(m4translation([-assembly.origin[0], -assembly.origin[1], -assembly.origin[2]]), placement) : placement;
        const inst = newInstance(draft, def.id as DefId, local, part.name);
        const holder = assembly ? assembly.container : cabinetContainer;
        (holder.instances as unknown as Map<Id, typeof inst>).set(inst.id, inst);
        holder.order.push(inst.id);
        parts.push({ name: part.assembly ? `${part.assembly}: ${part.name}` : part.name, id: inst.id, path: [...contextPath, placed.id, ...(assembly ? [assembly.id] : []), inst.id], size: part.size });
      }
      result = { instanceId: placed.id, definitionId: cabinet.id, name: plan.name, parts };
    });
    return result!;
  },
});

function partFar(p: CabinetPart): Vec3 {
  const end = (axis: Vec3, length: number, i: number): number => axis[i]! * length;
  return [0, 1, 2].map(i => p.origin[i]! + end(p.x, p.size[0], i) + end(p.y, p.size[1], i) + end(p.z, p.size[2], i)) as unknown as Vec3;
}

export const cabinetCommands: readonly AnyCommand[] = [cabinetGenerate];
