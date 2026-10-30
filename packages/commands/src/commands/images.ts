// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { m4translation, PushFormError, v3dot, v3sub } from '@pushform/core';
import type { Id, Mat4, MaterialId, PlaneBasis, Vec3 } from '@pushform/core';
import { base64ToBytes, containerAt, createMaterial, IMAGE_PIXEL_SIZE_M, imageEntityCorners, imageEntitySize, newImageEntity } from '@pushform/model';
import type { DocumentState, EntityRef, UvMapping } from '@pushform/model';
import { allocId } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { activeMaterialOf, hostOf } from '../host/services';
import { draftContainerAt, refsInContext, requireContextPath, sketchGraphAt } from './context';
import { ensureImageAsset } from './materials';
import { EntityRefSchema } from './sketch';
import { toEntityRefs } from './transform';

// Placed pictures (image entities): import a picture into the open group or component, turn one
// into a textured face (Explode), or make a material of it (Use as Material).

export interface ImageImportResult {
  readonly ref: EntityRef;
  readonly imageId: number;
  readonly widthM: number;
  readonly heightM: number;
}

export const imageImport = defineCommand({
  id: 'image.import',
  title: 'Import Image',
  category: 'edit',
  params: z.object({
    /** Raw bytes, or base64 (optionally a `data:` URL). */
    bytes: z.union([z.string(), z.instanceof(Uint8Array)]),
    name: z.string(),
    mime: z.string().default('image/png'),
    /** Pixel size when the caller already knows it (skips decoding). */
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    /** Size of one pixel in meters (1 mm). */
    pixelSizeM: z.number().positive().default(IMAGE_PIXEL_SIZE_M),
    /** Where the picture's origin corner goes, in the open context's coordinates (default its origin). */
    origin: z.tuple([z.number(), z.number(), z.number()]).optional(),
  }),
  undoable: false,
  async run(ctx, p): Promise<ImageImportResult> {
    const host = hostOf(ctx);
    const bytes = typeof p.bytes === 'string' ? base64ToBytes(p.bytes) : p.bytes;
    if (bytes.length === 0) throw new PushFormError('image.empty', 'The image is empty');
    const d = await host.images.describe(bytes, p.mime, { width: p.width, height: p.height });
    if (!(d.width > 0 && d.height > 0)) throw new PushFormError('image.size', `${p.name} could not be read as a picture`);
    const widthM = d.width * p.pixelSizeM, heightM = d.height * p.pixelSizeM;
    const path = host.context.path;
    const result = host.transact('Import Image', () =>
      host.edit('Import Image', (draft) => {
        const asset = ensureImageAsset(host, draft, bytes, p.name, p.mime, d);
        const container = draftContainerAt(draft, path);
        const id = allocId<Id>(draft);
        const transform = m4translation((p.origin ?? [0, 0, 0]) as Vec3) as unknown as Mat4;
        container.images.set(id, newImageEntity(id, asset.id, transform, widthM, heightM, draft.defaultTagId));
        container.order.push(id);
        return { ref: { kind: 'image', path: [...path], id } as EntityRef, imageId: asset.id as number, widthM, heightM };
      }),
      { commandId: 'image.import', params: { name: p.name, mime: p.mime } },
    );
    host.selection.set([result.ref]);
    return result;
  },
});

const ImageRefsSchema = z.object({ refs: z.array(EntityRefSchema).optional() });

function imageRefs(host: ReturnType<typeof hostOf>, refs: z.infer<typeof ImageRefsSchema>['refs']): EntityRef[] {
  const list = (refs ? toEntityRefs(refs) : host.selection.refs).filter((r) => r.kind === 'image');
  for (const r of list) requireContextPath(host, r.path, 'Image');
  const inContext = refsInContext(host, list);
  if (!inContext.length) throw new PushFormError('image.target', 'Select an image');
  return inContext;
}

/**
 * The affine texture placement that shows a picture across the parallelogram `corners` (from its origin corner) on a
 * face with basis `basis`: face (u, v) in meters → picture tiles, (0, 0) at corner 0 and (1, 1) at corner 2.
 */
export function pictureUv(corners: readonly Vec3[], basis: PlaneBasis): UvMapping {
  const c0 = corners[0]!, e1 = v3sub(corners[1]!, c0), e2 = v3sub(corners[3]!, c0);
  const a = v3dot(e1, e1), b = v3dot(e1, e2), c = v3dot(e2, e2), det = a * c - b * b;
  // Dual basis: s = alpha · (p - c0), t = beta · (p - c0) for points p in the parallelogram's plane.
  const alpha: Vec3 = [(c * e1[0] - b * e2[0]) / det, (c * e1[1] - b * e2[1]) / det, (c * e1[2] - b * e2[2]) / det];
  const beta: Vec3 = [(a * e2[0] - b * e1[0]) / det, (a * e2[1] - b * e1[1]) / det, (a * e2[2] - b * e1[2]) / det];
  const o = v3sub(basis.origin, c0);
  return { kind: 'affine', matrix: [v3dot(alpha, basis.u), v3dot(alpha, basis.v), v3dot(alpha, o), v3dot(beta, basis.u), v3dot(beta, basis.v), v3dot(beta, o)] };
}

export interface ImageExplodeResult {
  readonly refs: EntityRef[];
  readonly materialIds: number[];
}

/**
 * Each selected picture becomes a face with the same outline, painted on both sides with a new material
 * showing the picture where the image showed it; the image entity is removed and the faces become the selection.
 */
export const imageExplode = defineCommand({
  id: 'image.explode',
  title: 'Explode Image',
  category: 'edit',
  params: ImageRefsSchema,
  undoable: true,
  run(ctx, p): ImageExplodeResult {
    const host = hostOf(ctx);
    const refs = imageRefs(host, p.refs);
    const path = host.context.path;
    const out: EntityRef[] = [];
    const materialIds: number[] = [];
    host.edit('Explode Image', (draft) => {
      const state = draft as unknown as DocumentState;
      const container = draftContainerAt(draft, path);
      const g = sketchGraphAt(draft, path);
      for (const r of refs) {
        const image = container.images.get(r.id);
        if (!image) continue;
        if (image.locked) throw new PushFormError('image.locked', 'A locked image cannot be exploded');
        const corners = imageEntityCorners(image);
        const size = imageEntitySize(image);
        const asset = state.images.get(image.imageId);
        const material = createMaterial(draft, { name: asset?.name.replace(/\.[a-z0-9]+$/i, '') || 'Image', color: [0.8, 0.8, 0.8],
          texture: { imageId: image.imageId, widthM: size.width, heightM: size.height, colorize: false } });
        materialIds.push(material.id as number);
        const before = new Set(g.sketch.faces.keys());
        for (let i = 0; i < 4; i++) g.addEdge(corners[i]!, corners[(i + 1) % 4]!, { tagId: image.tagId });
        for (const face of g.sketch.faces.values()) {
          if (before.has(face.id)) continue;
          face.frontMaterialId = material.id as MaterialId;
          face.backMaterialId = material.id as MaterialId;
          face.uv = pictureUv(corners, face.basis);
          delete face.uvBack;
          out.push({ kind: 'sketchFace', path: [...path], id: face.id });
        }
        container.images.delete(image.id);
        container.order = container.order.filter((x) => x !== image.id);
      }
    });
    host.selection.set(out);
    return { refs: out, materialIds };
  },
});

/** A material showing the picture once across the image's placed size, which becomes the paint material. */
export const imageUseAsMaterial = defineCommand({
  id: 'image.useAsMaterial',
  title: 'Use as Material',
  category: 'edit',
  params: ImageRefsSchema,
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const [ref] = imageRefs(host, p.refs);
    const image = containerAt(host.doc.state, ref!.path).images.get(ref!.id);
    if (!image) throw new PushFormError('image.target', 'Select an image');
    const size = imageEntitySize(image);
    const asset = host.doc.state.images.get(image.imageId);
    const id = host.edit('Use as Material', (draft) => createMaterial(draft, { name: asset?.name.replace(/\.[a-z0-9]+$/i, '') || 'Image', color: [0.8, 0.8, 0.8],
      texture: { imageId: image.imageId, widthM: size.width, heightM: size.height, colorize: false } }).id as number);
    activeMaterialOf(ctx).set(id);
    return id;
  },
});

export const imageCommands: readonly AnyCommand[] = [imageImport, imageExplode, imageUseAsMaterial];
