// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { m4fromBasis, m4translation } from '@pushform/core';
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
import { loadLibraryMaterial, ensureDocumentImage } from './materials';
import { libraryMaterial } from './materialLibrary';
import { edgeAngleDeg } from './edges';

export const HARDWARE_FINISHES = {
  'matte-black': { name: 'Hardware — matte black', color: [0.075, 0.075, 0.08] },
  'satin-nickel': { name: 'Hardware — satin nickel', color: [0.64, 0.65, 0.63] },
  chrome: { name: 'Hardware — chrome tone', color: [0.78, 0.8, 0.82] },
  brass: { name: 'Hardware — brass', color: [0.72, 0.53, 0.24] },
  'champagne-bronze': { name: 'Hardware — champagne bronze', color: [0.68, 0.56, 0.38] },
  'oil-rubbed-bronze': { name: 'Hardware — oil-rubbed bronze', color: [0.2, 0.14, 0.1] },
  white: { name: 'Hardware — white finish', color: [0.95, 0.94, 0.91] },
  walnut: { name: 'Hardware — walnut', color: [0.28, 0.15, 0.08] },
  maple: { name: 'Hardware — maple', color: [0.77, 0.61, 0.41] },
} as const;
export type HardwareFinish = keyof typeof HARDWARE_FINISHES;
export const HardwareParamsSchema = z
  .object({
    shape: z
      .enum(HARDWARE_SHAPES)
      .default('bar-round')
      .describe('Use knob-domed for a smooth revolved head and neck.'),
    length: z.number().optional(),
    width: z.number().optional(),
    projection: z.number().optional(),
    spacing: z.number().optional(),
    grip: z.number().optional(),
    wall: z.number().optional(),
    segments: z
      .number()
      .int()
      .min(16)
      .max(80)
      .default(40)
      .describe(
        'Radial divisions. For domed knobs start with 32–48; cost grows with radial divisions times profile segments.',
      ),
    profileSegments: z
      .number()
      .int()
      .min(8)
      .max(32)
      .optional()
      .describe(
        'Domed knob profile divisions; default 20. Use 16–20 with 32–48 radial segments for about 1,000–2,000 triangles. Increase only for visible silhouette faceting; smooth shading handles the surface.',
      ),
    finish: z
      .enum(Object.keys(HARDWARE_FINISHES) as [HardwareFinish, ...HardwareFinish[]])
      .default('satin-nickel'),
    name: z.string().trim().min(1).max(180).optional(),
    replaceDefinitionId: z.number().int().positive().optional(),
    point: z.tuple([z.number(), z.number(), z.number()]).optional(),
    mountingPlane: z.enum(['front', 'top', 'side']).default('front'),
  })
  .strict();
export const hardwareCreate = defineCommand({
  id: 'hardware.create',
  title: 'Generate Cabinet Hardware',
  category: 'draw',
  params: HardwareParamsSchema,
  undoable: false,
  async run(ctx, p) {
    const host = hostOf(ctx),
      path = [...host.context.path];
    const original =
      p.replaceDefinitionId === undefined
        ? null
        : host.doc.state.definitions.get(p.replaceDefinitionId as DefId);
    if (p.replaceDefinitionId !== undefined && !original)
      throw new Error('The hardware definition no longer exists.');
    if (original) {
      let saved;
      try {
        saved = JSON.parse(original.description);
      } catch {
        throw new Error('Select a generated hardware component.');
      }
      if (saved.generator !== 'hardware') throw new Error('Select a generated hardware component.');
    }
    const { shape, length, width, projection, spacing, grip, wall, segments } = p;
    const options = {
      shape,
      segments,
      ...(p.profileSegments === undefined ? {} : { profileSegments: p.profileSegments }),
      ...(length === undefined ? {} : { length }),
      ...(width === undefined ? {} : { width }),
      ...(projection === undefined ? {} : { projection }),
      ...(spacing === undefined ? {} : { spacing }),
      ...(grip === undefined ? {} : { grip }),
      ...(wall === undefined ? {} : { wall }),
    };
    const materialKey = 'Hardware_' + p.finish;
    const library = libraryMaterial(materialKey);
    const loaded = library ? await loadLibraryMaterial(host, materialKey) : null;
    const made = await kernelOf(ctx).hardware({ options, nextFaceId: 1 });
    if (host.context.path.join('/') !== path.join('/'))
      throw new Error('The editing context changed while generating hardware.');
    let definitionId = 0 as DefId,
      instanceId: Id | null = null;
    const name = p.name ?? p.shape.replaceAll('-', ' ');
    host.edit('Generate Cabinet Hardware', (draft) => {
      const state = draft as unknown as DocumentState;
      const def: ReturnType<typeof createDefinition> = original
        ? (draft.definitions.get(original.id)! as unknown as ReturnType<typeof createDefinition>)
        : createDefinition(draft, {
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
      if (original) {
        const ids = new Set(def.entities.bodies.keys());
        def.entities.bodies.clear();
        def.entities.order = def.entities.order.filter((id) => !ids.has(id));
        def.description = JSON.stringify({
          generator: 'hardware',
          version: 1,
          ...made.resolved,
          finish: p.finish,
          mountingPlane: p.mountingPlane,
          mountingCenters: made.mountingCenters,
        });
      }
      definitionId = def.id;
      const f = HARDWARE_FINISHES[p.finish];
      const material =
        [...state.materials.values()].find((m) => m.name === f.name) ??
        createMaterial(draft, {
          name: f.name,
          color: [...f.color] as Rgb,
          texture: loaded?.texture
            ? {
                imageId: ensureDocumentImage(host, draft, loaded.texture.imageId),
                widthM: loaded.texture.widthM,
                heightM: loaded.texture.heightM,
                colorize: false,
                grain: loaded.texture.grain,
              }
            : null,
        });
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
        for (const face of body.faces.values()) {
          const axis = p.mountingPlane === 'side' ? 1 : 0,
            u = face.basis.u[axis]!,
            v = face.basis.v[axis]!,
            length = Math.hypot(u, v);
          if (length > 0) {
            const c = u / length,
              s = v / length;
            face.uv = { kind: 'sized', matrix: [c, s, 0, -s, c, 0] };
          }
        }
        for (const edge of body.edges.values()) {
          const a = edgeAngleDeg(body, edge);
          if (a !== null && a < 28) {
            edge.soft = true;
            edge.smooth = true;
          }
        }
      }
      const at = original ? null : (p.point ?? (ctx.tools ? null : [0, 0, 0]));
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
    else if (!original) {
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
