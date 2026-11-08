// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { m4fromBasis, m4translation, m4mul } from '@pushform/core';
import type { DefId, Id, Vec3 } from '@pushform/core';
import { HARDWARE_SHAPES } from '@pushform/kernel';
import { bodyFromMesh, createMaterial } from '@pushform/model';
import type { DocumentState, Draft, EntityContainer, Rgb } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf, kernelOf, activeTagOpt } from '../host/services';
import { currentFrame, draftContainerAt } from './context';
import { createDefinition, newInstance, uniqueDefinitionName } from './groups';
import { componentPlacement } from './components';
import { edgeAngleDeg } from './edges';

export const HARDWARE_FINISHES = {
  'matte-black': { name: 'Hardware — matte black', color: [0.075, 0.075, 0.08] },
  'satin-nickel': { name: 'Hardware — satin nickel', color: [0.64, 0.65, 0.63] },
  chrome: { name: 'Hardware — chrome tone', color: [0.78, 0.8, 0.82] },
  brass: { name: 'Hardware — brass', color: [0.72, 0.53, 0.24] },
  'champagne-bronze': { name: 'Hardware — champagne bronze', color: [0.68, 0.56, 0.38] },
  'oil-rubbed-bronze': { name: 'Hardware — oil-rubbed bronze', color: [0.2, 0.14, 0.1] },
  white: { name: 'Hardware — white ceramic', color: [0.95, 0.94, 0.91] },
  walnut: { name: 'Hardware — walnut', color: [0.28, 0.15, 0.08] },
  maple: { name: 'Hardware — maple', color: [0.77, 0.61, 0.41] },
} as const;
export type HardwareFinish = keyof typeof HARDWARE_FINISHES;
export const HardwareParamsSchema = z
  .object({
    shape: z.enum(HARDWARE_SHAPES).default('bar-round'),
    length: z.number().optional(),
    width: z.number().optional(),
    projection: z.number().optional(),
    spacing: z.number().optional(),
    grip: z.number().optional(),
    wall: z.number().optional(),
    segments: z.number().int().min(16).max(80).default(40),
    finish: z
      .enum(Object.keys(HARDWARE_FINISHES) as [HardwareFinish, ...HardwareFinish[]])
      .default('satin-nickel'),
    name: z.string().trim().min(1).max(180).optional(),
    point: z.tuple([z.number(), z.number(), z.number()]).optional(),
    mountingPlane: z.enum(['front', 'top', 'side']).default('front'),
  })
  .strict();
export const hardwareCreate = defineCommand({
  id: 'hardware.create',
  title: 'Generate Cabinet Hardware',
  category: 'internal',
  params: HardwareParamsSchema,
  undoable: false,
  async run(ctx, p) {
    const host = hostOf(ctx),
      path = [...host.context.path];
    const { shape, length, width, projection, spacing, grip, wall, segments } = p;
    const options = {
      shape,
      segments,
      ...(length === undefined ? {} : { length }),
      ...(width === undefined ? {} : { width }),
      ...(projection === undefined ? {} : { projection }),
      ...(spacing === undefined ? {} : { spacing }),
      ...(grip === undefined ? {} : { grip }),
      ...(wall === undefined ? {} : { wall }),
    };
    const made = await kernelOf(ctx).hardware({ options, nextFaceId: 1 });
    if (host.context.path.join('/') !== path.join('/'))
      throw new Error('The editing context changed while generating hardware.');
    let definitionId = 0 as DefId,
      instanceId: Id | null = null;
    const name = p.name ?? p.shape.replaceAll('-', ' ');
    host.edit('Generate Cabinet Hardware', (draft) => {
      const state = draft as unknown as DocumentState;
      const def = createDefinition(draft, {
        name: uniqueDefinitionName(state, name),
        isGroup: false,
        description: JSON.stringify({
          generator: 'hardware',
          version: 1,
          ...made.resolved,
          finish: p.finish,
          mountingPlane: p.mountingPlane,
          mountingCenters: made.mountingCenters,
        }),
      });
      definitionId = def.id;
      const f = HARDWARE_FINISHES[p.finish];
      const material =
        [...state.materials.values()].find((m) => m.name === f.name) ??
        createMaterial(draft, { name: f.name, color: [...f.color] as Rgb });
      const basis =
        p.mountingPlane === 'front'
          ? m4fromBasis([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0])
          : p.mountingPlane === 'side'
            ? m4fromBasis([0, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0])
            : m4translation([0, 0, 0]);
      for (const c of made.components) {
        const verts = new Float64Array(c.mesh.verts);
        for (let i = 0; i < verts.length; i += 3) {
          const [x, y, z] = [verts[i]!, verts[i + 1]!, verts[i + 2]!];
          verts[i] = basis[0]! * x + basis[4]! * y + basis[8]! * z;
          verts[i + 1] = basis[1]! * x + basis[5]! * y + basis[9]! * z;
          verts[i + 2] = basis[2]! * x + basis[6]! * y + basis[10]! * z;
        }
        const body = bodyFromMesh(
          draft,
          { ...c.mesh, verts },
          {
            container: def.entities as unknown as Draft<EntityContainer>,
            materialId: material.id,
            ...activeTagOpt(ctx),
          },
        );
        for (const edge of body.edges.values()) {
          const a = edgeAngleDeg(body, edge);
          if (a !== null && a < 28) {
            edge.soft = true;
            edge.smooth = true;
          }
        }
      }
      const at = p.point ?? (ctx.tools ? null : [0, 0, 0]);
      if (at) {
        const placed = newInstance(
          draft,
          def.id,
          m4translation(currentFrame(host).toLocal(at as Vec3)),
          name,
        );
        const into = draftContainerAt(draft, path);
        into.instances.set(placed.id, placed);
        into.order.push(placed.id);
        instanceId = placed.id;
      }
    });
    if (instanceId !== null) host.selection.set([{ kind: 'instance', path, id: instanceId }]);
    else {
      componentPlacement.current = definitionId;
      ctx.tools?.activate('placeComponent');
    }
    return {
      definitionId,
      instanceId,
      resolved: made.resolved,
      mountingCenters: made.mountingCenters,
      solids: made.components.length,
    };
  },
});
export const hardwareCommands: readonly AnyCommand[] = [hardwareCreate];
