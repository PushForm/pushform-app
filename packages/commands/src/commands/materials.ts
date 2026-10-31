// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { planeBasis, planeFlip, PushFormError } from '@pushform/core';
import type { FaceLocalId, Id, ImageId, MaterialId } from '@pushform/core';
import {
  base64ToBytes,
  containerAt,
  createMaterial,
  materialsInUse,
  replaceMaterialRefs,
  reverseLoop,
  sketchFaceEdgeIds,
  textureTiles,
  UV_AUTO,
  uniqueMaterialName,
  uvClone,
  uvRebaseSides,
} from '@pushform/model';
import type { Body, DocumentDraft, DocumentState, EntityContainer, EntityRef, ImageAsset, Material, MaterialTexture, Rgb, Sketch, UvMapping } from '@pushform/model';
import { allocId, entityRefKey } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import type { DocumentHost } from '../host/DocumentHost';
import { activeMaterialOf, hostOf } from '../host/services';
import { draftContainerAt, requireContextPath, samePath } from './context';
import { EntityRefSchema } from './sketch';
import { surfaceRefs } from './sketchQueries';
import { BUILTIN_LIBRARY, generateLibraryTexture, libraryMaterial } from './materialLibrary';
import { positionTextureCommands } from '../tools/impl/PositionTexture';

/**
 * Materials (Materials panel), the Paint Bucket and texture
 * positioning. Materials are document-wide; painting writes the explicit
 * front/back material of faces (body faces and sketch faces), the default material of bodies and
 * the instance material of groups/components (inherited by their default-material faces).
 */

// ---------------------------------------------------------------------------------------------
// Schemas

const rgb = z.tuple([z.number(), z.number(), z.number()]);
const idSchema = z.number().int().nonnegative();
/** A material id, or null for the default material. */
const materialIdSchema = z.number().int().nonnegative().nullable();
const textureSchema = z.object({
  imageId: idSchema,
  widthM: z.number().positive(),
  heightM: z.number().positive(),
  /** Colorize the texture toward the material color. */
  colorize: z.boolean().optional(),
  colorizeType: z.enum(['shift', 'tint']).optional(),
});
const uvSchema = z.union([
  z.object({ kind: z.literal('auto') }),
  z.object({ kind: z.literal('affine'), matrix: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]) }),
  z.object({ kind: z.literal('projective'), matrix: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]) }),
  z.object({ kind: z.literal('sized'), matrix: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]) }),
]);
const sideSchema = z.enum(['front', 'back', 'both']);
export type PaintSide = z.infer<typeof sideSchema>;
export const PAINT_MODES = ['single', 'adjacent', 'replaceAll', 'replaceOnObject', 'sample'] as const;
export type PaintMode = (typeof PAINT_MODES)[number];

export const PaintApplyParamsSchema = z.object({
  /** Targets; the current selection when omitted. */
  refs: z.array(EntityRefSchema).optional(),
  materialId: materialIdSchema,
  mode: z.enum(PAINT_MODES).default('single'),
  side: sideSchema.default('front'),
});
export type PaintApplyParams = z.infer<typeof PaintApplyParamsSchema>;

export interface PaintResult {
  /** Faces / bodies / instances painted. */
  readonly painted: number;
  readonly materialId: number | null;
  /** The material under the first target (sample mode, and what the replace modes matched). */
  readonly sampled: number | null;
}

type RefParam = z.infer<typeof EntityRefSchema>;

/** Validated ref params → runtime refs. */
export function paramRefs(refs: readonly RefParam[]): EntityRef[] {
  return refs.map((r): EntityRef => {
    const path = r.path as Id[], id = r.id as Id;
    switch (r.kind) {
      case 'face':
        return { kind: 'face', path, id, faceId: r.faceId as FaceLocalId, region: r.region ?? null };
      case 'edge':
        return { kind: 'edge', path, id, edgeKey: r.edgeKey as never };
      case 'imprintEdge':
        return { kind: 'imprintEdge', path, id, faceId: r.faceId as FaceLocalId, edgeId: r.edgeId ?? 0 };
      default:
        return { kind: r.kind, path, id };
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** `null` for the default material id, else the id (validated to exist). */
function normalizeMaterialId(state: DocumentState, id: number | null): MaterialId | null {
  if (id === null || id === state.defaultMaterialId) return null;
  if (!state.materials.has(id as MaterialId)) throw new PushFormError('material.missing', `Material ${id} not found`);
  return id as MaterialId;
}

function requireMaterial(state: DocumentState, id: number): Material {
  const m = state.materials.get(id as MaterialId);
  if (!m) throw new PushFormError('material.missing', `Material ${id} not found`);
  return m;
}

/**
 * Make sure `imageId` is a document asset: a runtime-only id from `host.images` (library or
 * imported texture not yet written) is copied into the draft under a fresh document id.
 */
export function ensureDocumentImage(host: DocumentHost, draft: DocumentDraft, imageId: number): ImageId {
  const docState = draft as unknown as DocumentState;
  if (docState.images.has(imageId as ImageId)) return imageId as ImageId;
  const asset = host.images.asset(imageId as ImageId);
  const blob = host.images.get(imageId as ImageId);
  if (!asset || !blob) throw new PushFormError('image.missing', `Image ${imageId} not found`);
  for (const existing of docState.images.values()) {
    if (existing.sha256 === asset.sha256) {
      if (!host.images.has(existing.id)) host.images.register(existing, blob.bytes, blob.mime);
      return existing.id;
    }
  }
  const id = allocId<ImageId>(draft);
  const copy: ImageAsset = { ...asset, id };
  (draft.images as unknown as Map<ImageId, ImageAsset>).set(id, copy);
  host.images.register(copy, blob.bytes, blob.mime);
  return id;
}

type FaceSide = 'front' | 'back';
const sidesOf = (side: PaintSide): FaceSide[] => (side === 'both' ? ['front', 'back'] : [side]);
const sideKey = (s: FaceSide): 'frontMaterialId' | 'backMaterialId' => (s === 'front' ? 'frontMaterialId' : 'backMaterialId');

/** A face target: a body face or a sketch face plus the sides to paint. */
type FaceTarget = { kind: 'face'; bodyId: Id; faceId: FaceLocalId; sides: FaceSide[] } | { kind: 'sketchFace'; id: Id; sides: FaceSide[] };
/**
 * A whole body is loose geometry (a drag-selected "shape"), so painting it paints
 * every face explicitly; only a group/component instance takes a default material.
 */
type Target = FaceTarget | { kind: 'body'; id: Id; sides: FaceSide[] } | { kind: 'meshPart'; id: Id } | { kind: 'instance'; id: Id };

const targetKey = (t: Target): string =>
  t.kind === 'face' ? `f/${t.bodyId}/${t.faceId}` : t.kind === 'sketchFace' ? `s/${t.id}` : `${t.kind}/${t.id}`;

/** Explicit material of a face side (null = default). */
function faceSideMaterial(c: EntityContainer, t: FaceTarget, side: FaceSide): MaterialId | null | undefined {
  if (t.kind === 'face') return c.bodies.get(t.bodyId)?.faces.get(t.faceId)?.[sideKey(side)];
  return c.sketch.faces.get(t.id)?.[sideKey(side)];
}

/** Edge-connected neighbours of a body face. */
function bodyNeighbours(body: Body): Map<FaceLocalId, FaceLocalId[]> {
  const adj = new Map<FaceLocalId, FaceLocalId[]>();
  const link = (a: FaceLocalId, b: FaceLocalId) => {
    const l = adj.get(a);
    if (l) l.push(b);
    else adj.set(a, [b]);
  };
  for (const e of body.edges.values()) {
    if (e.faceA === e.faceB) continue;
    link(e.faceA, e.faceB);
    link(e.faceB, e.faceA);
  }
  return adj;
}

/** Sketch faces sharing an edge with each face. */
function sketchNeighbours(sketch: Sketch): Map<Id, Id[]> {
  const byEdge = new Map<Id, Id[]>();
  for (const f of sketch.faces.values()) {
    for (const e of sketchFaceEdgeIds(f)) {
      const l = byEdge.get(e);
      if (l) l.push(f.id);
      else byEdge.set(e, [f.id]);
    }
  }
  const adj = new Map<Id, Id[]>();
  for (const faces of byEdge.values()) {
    for (const a of faces) {
      for (const b of faces) {
        if (a === b) continue;
        const l = adj.get(a);
        if (l) l.push(b);
        else adj.set(a, [b]);
      }
    }
  }
  return adj;
}

/** Flood fill over edge-connected faces with the same explicit material on `side` as the start face. */
function adjacentTargets(c: EntityContainer, start: FaceTarget, side: FaceSide): FaceTarget[] {
  const sample = faceSideMaterial(c, start, side);
  if (sample === undefined) return [];
  const out: FaceTarget[] = [];
  if (start.kind === 'face') {
    const body = c.bodies.get(start.bodyId);
    if (!body) return [];
    const adj = bodyNeighbours(body);
    const seen = new Set<FaceLocalId>([start.faceId]);
    const queue = [start.faceId];
    while (queue.length) {
      const f = queue.shift()!;
      out.push({ kind: 'face', bodyId: start.bodyId, faceId: f, sides: start.sides });
      for (const n of adj.get(f) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        if ((body.faces.get(n)?.[sideKey(side)] ?? null) === (sample ?? null)) queue.push(n);
      }
    }
  } else {
    const adj = sketchNeighbours(c.sketch);
    const seen = new Set<Id>([start.id]);
    const queue = [start.id];
    while (queue.length) {
      const f = queue.shift()!;
      out.push({ kind: 'sketchFace', id: f, sides: start.sides });
      for (const n of adj.get(f) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        if ((c.sketch.faces.get(n)?.[sideKey(side)] ?? null) === (sample ?? null)) queue.push(n);
      }
    }
  }
  return out;
}

/** Every face side in the container (or only `onlyBody` / the sketch) whose explicit material is `sample`. */
function matchingTargets(c: EntityContainer, sample: MaterialId | null, scope: { bodyId?: Id; sketch?: boolean } | null): FaceTarget[] {
  const out: FaceTarget[] = [];
  const all = scope === null;
  if (all || scope.bodyId !== undefined) {
    for (const body of c.bodies.values()) {
      if (!all && body.id !== scope.bodyId) continue;
      for (const f of body.faces.values()) {
        const sides: FaceSide[] = [];
        if ((f.frontMaterialId ?? null) === sample) sides.push('front');
        if ((f.backMaterialId ?? null) === sample) sides.push('back');
        if (sides.length) out.push({ kind: 'face', bodyId: body.id, faceId: f.id, sides });
      }
    }
  }
  if (all || scope.sketch) {
    for (const f of c.sketch.faces.values()) {
      const sides: FaceSide[] = [];
      if ((f.frontMaterialId ?? null) === sample) sides.push('front');
      if ((f.backMaterialId ?? null) === sample) sides.push('back');
      if (sides.length) out.push({ kind: 'sketchFace', id: f.id, sides });
    }
  }
  return out;
}

/** Refs of the current context → paint targets (edges and other kinds are ignored). A mesh part is painted whole. */
function targetsOf(host: DocumentHost, refs: readonly EntityRef[], side: PaintSide): Target[] {
  const c = containerAt(host.doc.state, host.context.path);
  const out: Target[] = [];
  for (const r of refs) {
    requireContextPath(host, r.path, 'Paint target');
    switch (r.kind) {
      case 'face':
        if (c.bodies.get(r.id)?.faces.has(r.faceId)) out.push({ kind: 'face', bodyId: r.id, faceId: r.faceId, sides: sidesOf(side) });
        break;
      case 'sketchFace':
        if (c.sketch.faces.has(r.id)) out.push({ kind: 'sketchFace', id: r.id, sides: sidesOf(side) });
        break;
      case 'body':
        if (c.bodies.has(r.id)) out.push({ kind: 'body', id: r.id, sides: sidesOf(side) });
        break;
      case 'meshPart':
        if (c.meshParts.has(r.id)) out.push({ kind: 'meshPart', id: r.id });
        break;
      case 'instance':
        if (c.instances.has(r.id)) out.push({ kind: 'instance', id: r.id });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Material under a target: explicit face material (else the body's), body material, instance material. */
export function sampleTarget(c: EntityContainer, t: Target, side: FaceSide): MaterialId | null {
  switch (t.kind) {
    case 'face': {
      const b = c.bodies.get(t.bodyId);
      const f = b?.faces.get(t.faceId);
      return f?.[sideKey(side)] ?? b?.materialId ?? null;
    }
    case 'sketchFace':
      return c.sketch.faces.get(t.id)?.[sideKey(side)] ?? null;
    case 'body':
      return c.bodies.get(t.id)?.materialId ?? null;
    case 'meshPart':
      return c.meshParts.get(t.id)?.materialId ?? null;
    case 'instance':
      return c.instances.get(t.id)?.materialId ?? null;
  }
}

/** Material under a ref of the current context (what the Paint Bucket samples). */
export function sampleRef(host: DocumentHost, ref: EntityRef, side: PaintSide = 'front'): MaterialId | null {
  const targets = targetsOf(host, [ref], side);
  const t = targets[0];
  if (!t) return null;
  return sampleTarget(containerAt(host.doc.state, host.context.path), t, side === 'back' ? 'back' : 'front');
}

function applyTargets(draft: DocumentDraft, path: readonly number[], targets: readonly Target[], materialId: MaterialId | null): number {
  const c = draftContainerAt(draft, path);
  let n = 0;
  for (const t of targets) {
    switch (t.kind) {
      case 'face': {
        const f = c.bodies.get(t.bodyId)?.faces.get(t.faceId);
        if (!f) break;
        for (const s of t.sides) f[sideKey(s)] = materialId;
        n++;
        break;
      }
      case 'sketchFace': {
        const f = c.sketch.faces.get(t.id);
        if (!f) break;
        for (const s of t.sides) f[sideKey(s)] = materialId;
        n++;
        break;
      }
      case 'body': {
        const b = c.bodies.get(t.id);
        if (!b) break;
        b.materialId = materialId;
        for (const f of b.faces.values()) for (const s of t.sides) f[sideKey(s)] = materialId;
        n++;
        break;
      }
      case 'meshPart': {
        // The part's material backs the source faces without a color of their own; `faceMaterials` stays.
        const part = c.meshParts.get(t.id);
        if (!part) break;
        part.materialId = materialId;
        n++;
        break;
      }
      case 'instance': {
        const inst = c.instances.get(t.id);
        if (!inst) break;
        inst.materialId = materialId;
        n++;
        break;
      }
    }
  }
  return n;
}

/** Expand the clicked targets per paint mode (pure; reads the current state). */
export function expandPaintTargets(host: DocumentHost, targets: readonly Target[], mode: PaintMode, side: PaintSide): Target[] {
  if (mode === 'single' || mode === 'sample') return [...targets];
  const c = containerAt(host.doc.state, host.context.path);
  const primary: FaceSide = side === 'back' ? 'back' : 'front';
  const out = new Map<string, Target>();
  const add = (t: Target) => {
    const k = targetKey(t);
    const prev = out.get(k);
    if (prev && 'sides' in prev && 'sides' in t) {
      for (const s of t.sides) if (!prev.sides.includes(s)) prev.sides.push(s);
    } else out.set(k, t);
  };
  for (const t of targets) {
    if (t.kind === 'body' || t.kind === 'meshPart' || t.kind === 'instance') {
      add(t);
      continue;
    }
    if (mode === 'adjacent') {
      for (const a of adjacentTargets(c, t, primary)) add(a);
      continue;
    }
    const sample = faceSideMaterial(c, t, primary) ?? null;
    const scope = mode === 'replaceAll' ? null : t.kind === 'face' ? { bodyId: t.bodyId } : { sketch: true };
    for (const m of matchingTargets(c, sample, scope)) add({ ...m, sides: m.sides.filter((s) => side === 'both' || s === primary) });
    if (!out.has(targetKey(t))) add(t);
  }
  return [...out.values()].filter((t) => !('sides' in t) || t.sides.length > 0);
}

// ---------------------------------------------------------------------------------------------
// material.* commands

export const materialCreate = defineCommand({
  id: 'material.create',
  title: 'Create Material',
  category: 'edit',
  params: z.object({
    name: z.string().optional(),
    color: rgb.default([1, 1, 1]),
    alpha: z.number().min(0).max(1).optional(),
    texture: textureSchema.optional(),
    /** Make it the active (Paint Bucket) material (default true). */
    activate: z.boolean().default(true),
  }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const id = host.edit('Create Material', (draft) => {
      let texture: MaterialTexture | null = null;
      if (p.texture) {
        texture = { imageId: ensureDocumentImage(host, draft, p.texture.imageId), widthM: p.texture.widthM, heightM: p.texture.heightM, colorize: p.texture.colorize ?? false,
          ...(p.texture.colorizeType ? { colorizeType: p.texture.colorizeType } : {}) };
      }
      const m = createMaterial(draft, { name: p.name ?? 'Material', color: p.color as Rgb, alpha: p.alpha, texture });
      return m.id as number;
    });
    if (p.activate) activeMaterialOf(ctx).set(id);
    return id;
  },
});

export const materialUpdate = defineCommand({
  id: 'material.update',
  title: 'Edit Material',
  category: 'edit',
  params: z.object({
    id: idSchema,
    name: z.string().optional(),
    color: rgb.optional(),
    alpha: z.number().min(0).max(1).optional(),
    /** New texture, a partial update of the existing one, or null to remove it. */
    texture: textureSchema.partial().nullable().optional(),
  }),
  undoable: true,
  run(ctx, p): boolean {
    const host = hostOf(ctx);
    requireMaterial(host.doc.state, p.id);
    return host.edit('Edit Material', (draft) => {
      const m = draft.materials.get(p.id as MaterialId);
      if (!m) return false;
      if (p.name !== undefined) m.name = uniqueMaterialName(draft as unknown as DocumentState, p.name, m.id);
      if (p.color) m.color = [p.color[0], p.color[1], p.color[2]];
      if (p.alpha !== undefined) m.alpha = p.alpha;
      if (p.texture === null) m.texture = null;
      else if (p.texture) {
        const prev = m.texture;
        const imageId = p.texture.imageId !== undefined ? ensureDocumentImage(host, draft, p.texture.imageId) : prev?.imageId;
        if (imageId === undefined) throw new PushFormError('command.params', 'material.update: a texture needs an imageId');
        m.texture = {
          imageId,
          widthM: p.texture.widthM ?? prev?.widthM ?? 1,
          heightM: p.texture.heightM ?? prev?.heightM ?? 1,
          colorize: p.texture.colorize ?? prev?.colorize ?? false,
          ...((p.texture.colorizeType ?? prev?.colorizeType) ? { colorizeType: p.texture.colorizeType ?? prev?.colorizeType } : {}),
        };
      }
      return true;
    });
  },
});

export const materialDelete = defineCommand({
  id: 'material.delete',
  title: 'Delete Material',
  category: 'edit',
  params: z.object({ id: idSchema }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const state = host.doc.state;
    if (p.id === state.defaultMaterialId) throw new PushFormError('material.default', 'The default material cannot be deleted');
    requireMaterial(state, p.id);
    const active = activeMaterialOf(ctx);
    if (active.get() === p.id) active.set(null);
    return host.edit('Delete Material', (draft) => {
      const n = replaceMaterialRefs(draft, p.id as MaterialId, null);
      draft.materials.delete(p.id as MaterialId);
      return n;
    });
  },
});

export const materialDuplicate = defineCommand({
  id: 'material.duplicate',
  title: 'Duplicate Material',
  category: 'edit',
  params: z.object({ id: idSchema, activate: z.boolean().default(true) }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const src = requireMaterial(host.doc.state, p.id);
    const id = host.edit('Duplicate Material', (draft) => createMaterial(draft, { name: src.name, color: src.color, alpha: src.alpha, texture: src.texture }).id as number);
    if (p.activate) activeMaterialOf(ctx).set(id);
    return id;
  },
});

export const materialPurgeUnused = defineCommand({
  id: 'material.purgeUnused',
  title: 'Purge Unused Materials',
  category: 'edit',
  params: z.object({}),
  undoable: true,
  run(ctx): number {
    const host = hostOf(ctx);
    const used = materialsInUse(host.doc.state);
    const unused = [...host.doc.state.materials.keys()].filter((id) => !used.has(id));
    if (unused.length === 0) return 0;
    const active = activeMaterialOf(ctx);
    if (active.get() !== null && unused.includes(active.get() as MaterialId)) active.set(null);
    return host.edit('Purge Unused Materials', (draft) => {
      for (const id of unused) draft.materials.delete(id);
      return unused.length;
    });
  },
});

export interface ImportImageResult {
  readonly imageId: number;
  readonly materialId: number | null;
  readonly width: number;
  readonly height: number;
}

/** The described image as a document asset: an identical image the model already holds, else a new asset; its bytes are registered. */
export function ensureImageAsset(host: DocumentHost, draft: DocumentDraft, bytes: Uint8Array, name: string, mime: string,
  d: { width: number; height: number; sha256: string }): ImageAsset {
  const docState = draft as unknown as DocumentState;
  let asset = [...docState.images.values()].find((a) => a.sha256 === d.sha256);
  if (!asset) {
    const id = allocId<ImageId>(draft);
    asset = { id, name, mime, width: d.width, height: d.height, sha256: d.sha256 };
    (draft.images as unknown as Map<ImageId, ImageAsset>).set(id, asset);
  }
  host.images.register(asset, bytes, mime);
  return asset;
}

/** Default physical width of an imported texture (1 m). */
export const DEFAULT_TEXTURE_WIDTH_M = 1;

export const materialImportImage = defineCommand({
  id: 'material.importImage',
  title: 'Import Texture Image',
  category: 'edit',
  params: z.object({
    /** Raw bytes, or base64 (optionally a `data:` URL). */
    bytes: z.union([z.string(), z.instanceof(Uint8Array)]),
    name: z.string(),
    mime: z.string().default('image/png'),
    widthM: z.number().positive().optional(),
    heightM: z.number().positive().optional(),
    /** Pixel size when the caller already knows it (skips decoding). */
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    /** Also create a material using the image (default true); named after the image. */
    createMaterial: z.boolean().default(true),
    materialName: z.string().optional(),
    activate: z.boolean().default(true),
  }),
  undoable: false,
  async run(ctx, p): Promise<ImportImageResult> {
    const host = hostOf(ctx);
    const bytes = typeof p.bytes === 'string' ? base64ToBytes(p.bytes) : p.bytes;
    if (bytes.length === 0) throw new PushFormError('image.empty', 'The image is empty');
    const d = await host.images.describe(bytes, p.mime, { width: p.width, height: p.height });
    const aspect = d.width > 0 && d.height > 0 ? d.height / d.width : 1;
    const widthM = p.widthM ?? (p.heightM !== undefined ? p.heightM / aspect : DEFAULT_TEXTURE_WIDTH_M);
    const heightM = p.heightM ?? widthM * aspect;
    const baseName = p.name.replace(/\.[a-z0-9]+$/i, '') || 'Texture';
    const result = host.transact('Import Texture', () =>
      host.edit('Import Texture', (draft) => {
        const asset = ensureImageAsset(host, draft, bytes, p.name, p.mime, d);
        let materialId: number | null = null;
        if (p.createMaterial) {
          const m = createMaterial(draft, {
            name: p.materialName ?? baseName,
            color: [0.8, 0.8, 0.8],
            texture: { imageId: asset.id, widthM, heightM, colorize: false },
          });
          materialId = m.id;
        }
        return { imageId: asset.id as number, materialId, width: d.width, height: d.height };
      }),
      { commandId: 'material.importImage', params: { name: p.name, mime: p.mime } },
    );
    if (p.activate && result.materialId !== null) activeMaterialOf(ctx).set(result.materialId);
    return result;
  },
});

export const materialFromLibrary = defineCommand({
  id: 'material.fromLibrary',
  title: 'Add Library Material',
  category: 'edit',
  params: z.object({ key: z.string(), activate: z.boolean().default(true) }),
  undoable: false,
  async run(ctx, p): Promise<number> {
    const host = hostOf(ctx);
    const entry = libraryMaterial(p.key);
    if (!entry) throw new PushFormError('material.library', `Unknown library material ${p.key}`);
    // Reuse an in-model copy of the same library entry (one "In Model" copy is kept).
    for (const m of host.doc.state.materials.values()) {
      if (m.name === entry.name) {
        if (p.activate) activeMaterialOf(ctx).set(m.id);
        return m.id;
      }
    }
    let texture: { imageId: number; widthM: number; heightM: number } | null = null;
    if (entry.texture) {
      const png = generateLibraryTexture(entry.key);
      if (png) {
        const asset = await host.images.put(png, 'image/png', `${entry.name}.png`, { width: entry.texture.px, height: entry.texture.px });
        texture = { imageId: asset.id, widthM: entry.texture.widthM, heightM: entry.texture.heightM };
      }
    }
    const id = host.transact('Add Material', () =>
      host.edit('Add Material', (draft) => {
        const tex: MaterialTexture | null = texture
          ? { imageId: ensureDocumentImage(host, draft, texture.imageId), widthM: texture.widthM, heightM: texture.heightM, colorize: false }
          : null;
        return createMaterial(draft, { name: entry.name, color: entry.color, alpha: entry.alpha, texture: tex }).id as number;
      }),
      { commandId: 'material.fromLibrary', params: p },
    );
    if (p.activate) activeMaterialOf(ctx).set(id);
    return id;
  },
});

export const materialLibraryList = defineCommand({
  id: 'material.library',
  title: 'Material Library',
  category: 'internal',
  params: z.object({}),
  undoable: false,
  run: () => BUILTIN_LIBRARY.map((m) => ({ key: m.key, name: m.name, color: m.color, textured: !!m.texture, category: m.category })),
});

export const materialSetActive = defineCommand({
  id: 'material.setActive',
  title: 'Set Active Material',
  category: 'internal',
  params: z.object({ id: materialIdSchema }),
  undoable: false,
  run(ctx, p): number | null {
    const host = hostOf(ctx);
    const id = p.id === null ? null : normalizeMaterialId(host.doc.state, p.id);
    activeMaterialOf(ctx).set(id);
    return id;
  },
});

export const materialGetActive = defineCommand({
  id: 'material.getActive',
  title: 'Active Material',
  category: 'internal',
  params: z.object({}),
  undoable: false,
  run: (ctx): number | null => activeMaterialOf(ctx).get(),
});

/** Select every face of the current context that shows the material (In Model › Select). */
export const materialSelectFaces = defineCommand({
  id: 'material.selectFaces',
  title: 'Select Faces With Material',
  category: 'edit',
  params: z.object({ id: materialIdSchema }),
  undoable: false,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const id = p.id === null ? null : normalizeMaterialId(host.doc.state, p.id);
    const path = host.context.path;
    const c = containerAt(host.doc.state, path);
    const refs: EntityRef[] = [];
    for (const t of matchingTargets(c, id, null)) {
      if (t.kind === 'face') refs.push({ kind: 'face', path, id: t.bodyId, faceId: t.faceId, region: null });
      else refs.push({ kind: 'sketchFace', path, id: t.id });
    }
    host.selection.set(refs);
    return refs.length;
  },
});

// ---------------------------------------------------------------------------------------------
// paint.* commands

export const paintApply = defineCommand({
  id: 'paint.apply',
  title: 'Paint',
  category: 'edit',
  params: PaintApplyParamsSchema,
  undoable: true,
  run(ctx, p): PaintResult {
    const host = hostOf(ctx);
    const state = host.doc.state;
    const materialId = normalizeMaterialId(state, p.materialId);
    const refs = p.refs ? paramRefs(p.refs) : host.selection.refs.filter((r) => samePath(r.path, host.context.path));
    const clicked = targetsOf(host, refs, p.side);
    const c = containerAt(state, host.context.path);
    const sampled = clicked[0] ? sampleTarget(c, clicked[0], p.side === 'back' ? 'back' : 'front') : null;
    if (p.mode === 'sample') {
      activeMaterialOf(ctx).set(sampled);
      return { painted: 0, materialId: sampled, sampled };
    }
    // A face of a smooth surface paints the whole surface.
    const seen = new Set<string>();
    const whole = refs.flatMap((r) => surfaceRefs(state, r)).filter((r) => {
      const key = entityRefKey(r.kind === 'face' ? { ...r, region: null } : r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const targets = expandPaintTargets(host, targetsOf(host, whole, p.side), p.mode, p.side);
    if (targets.length === 0) return { painted: 0, materialId, sampled };
    const painted = host.edit('Paint', (draft) => applyTargets(draft, host.context.path, targets, materialId));
    return { painted, materialId, sampled };
  },
});

export const paintSample = defineCommand({
  id: 'paint.sample',
  title: 'Sample Material',
  category: 'edit',
  params: z.object({ ref: EntityRefSchema, side: sideSchema.default('front') }),
  undoable: false,
  run(ctx, p): number | null {
    const host = hostOf(ctx);
    const id = sampleRef(host, paramRefs([p.ref])[0]!, p.side);
    activeMaterialOf(ctx).set(id);
    return id;
  },
});

// ---------------------------------------------------------------------------------------------
// texture.* commands

function faceRefsOf(host: DocumentHost, refs: readonly EntityRef[] | undefined): EntityRef[] {
  const list = refs ?? host.selection.refs;
  return list.filter((r) => (r.kind === 'face' || r.kind === 'sketchFace') && samePath(r.path, host.context.path));
}

/**
 * Set the front texture mapping of the faces. A back side with its own mapping (`uvBack`, from an
 * imported .skp face) keeps it, unless `both`: then the back follows the front again.
 */
function setUv(draft: DocumentDraft, path: readonly number[], refs: readonly EntityRef[], uv: UvMapping, both = false): number {
  const c = draftContainerAt(draft, path);
  let n = 0;
  for (const r of refs) {
    const f = r.kind === 'face' ? c.bodies.get(r.id)?.faces.get(r.faceId) : r.kind === 'sketchFace' ? c.sketch.faces.get(r.id) : undefined;
    if (!f) continue;
    f.uv = uvClone(uv);
    if (both) delete f.uvBack;
    n++;
  }
  return n;
}

export const texturePosition = defineCommand({
  id: 'texture.position',
  title: 'Position Texture',
  category: 'edit',
  params: z.object({ ref: EntityRefSchema, uv: uvSchema }),
  undoable: true,
  run(ctx, p): boolean {
    const host = hostOf(ctx);
    const ref = paramRefs([p.ref])[0]!;
    if (ref.kind !== 'face' && ref.kind !== 'sketchFace') throw new PushFormError('command.params', 'texture.position needs a face');
    requireContextPath(host, ref.path, 'Face');
    return host.edit('Position Texture', (draft) => setUv(draft, host.context.path, [ref], p.uv as UvMapping) > 0);
  },
});

export const textureReset = defineCommand({
  id: 'texture.reset',
  title: 'Reset Texture Position',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema).optional() }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const refs = faceRefsOf(host, p.refs ? paramRefs(p.refs) : undefined);
    if (refs.length === 0) return 0;
    return host.edit('Reset Texture Position', (draft) => setUv(draft, host.context.path, refs, UV_AUTO, true));
  },
});

/**
 * Reverse Faces: turns sketch faces over. Each face's normal and loops flip, and its sides trade materials and
 * texture placements, so both sides look as before. Faces of a solid always face outward and are left alone.
 */
export const facesReverse = defineCommand({
  id: 'faces.reverse',
  title: 'Reverse Faces',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema).optional() }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const refs = faceRefsOf(host, p.refs ? paramRefs(p.refs) : undefined);
    const sketchFaces = refs.filter((r) => r.kind === 'sketchFace');
    if (!sketchFaces.length) {
      if (refs.length) throw new PushFormError('faces.solid', 'Faces of a solid always face outward and cannot be reversed');
      return 0;
    }
    const tiles = textureTiles(host.doc.state);
    return host.edit('Reverse Faces', (draft) => {
      const sketch = draftContainerAt(draft, host.context.path).sketch;
      let n = 0;
      for (const r of sketchFaces) {
        const f = sketch.faces.get(r.id);
        if (!f) continue;
        const plane = planeFlip(f.plane);
        const basis = planeBasis(f.basis.origin, plane.n);
        // The back's placement becomes the front's, both re-expressed in the flipped face's basis.
        const sides = { uv: f.uvBack ?? f.uv, uvBack: f.uvBack ? f.uv : undefined };
        const r2 = uvRebaseSides(sides, f.basis, basis, tiles(f.backMaterialId), tiles(f.frontMaterialId));
        [f.frontMaterialId, f.backMaterialId] = [f.backMaterialId, f.frontMaterialId];
        f.plane = plane;
        f.basis = basis;
        f.loops = f.loops.map(reverseLoop);
        f.uv = r2.uv;
        if (r2.uvBack) f.uvBack = r2.uvBack;
        else delete f.uvBack;
        n++;
      }
      return n;
    });
  },
});

/** Placeholder (Texture › Projected): not implemented yet. */
export const textureProjected = defineCommand({
  id: 'texture.projected',
  title: 'Projected',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema).optional() }),
  undoable: false,
  when: () => false,
  run(): never {
    throw new PushFormError('command.notImplemented', 'Projected textures are not implemented yet');
  },
});

export const materialCommands: readonly AnyCommand[] = [
  materialCreate,
  materialUpdate,
  materialDelete,
  materialDuplicate,
  materialPurgeUnused,
  materialImportImage,
  materialFromLibrary,
  materialLibraryList,
  materialSetActive,
  materialGetActive,
  materialSelectFaces,
  paintApply,
  paintSample,
  texturePosition,
  textureReset,
  textureProjected,
  facesReverse,
  ...positionTextureCommands,
];
