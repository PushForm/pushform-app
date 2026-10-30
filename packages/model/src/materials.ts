// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, MaterialId } from '@pushform/core';
import type { Material, MaterialTexture, Rgb } from './entities/attrs';
import type { DocumentState } from './entities/document';
import { allocId, type DocumentDraft } from './Document';

/**
 * Material helpers: creation with unique names, usage queries (which faces / bodies / instances
 * reference a material) and the resolution of a face's effective material (face → body → instance).
 */

export interface CreateMaterialOptions {
  readonly name: string;
  readonly color: Rgb;
  readonly alpha?: number | undefined;
  readonly texture?: MaterialTexture | null | undefined;
}

/** `name`, or `name#n` with the smallest n ≥ 1 that no other material uses. */
export function uniqueMaterialName(state: Pick<DocumentState, 'materials'>, name: string, exceptId?: MaterialId): string {
  const taken = new Set<string>();
  for (const m of state.materials.values()) if (m.id !== exceptId) taken.add(m.name);
  const base = name.trim() || 'Material';
  if (!taken.has(base)) return base;
  const stem = base.replace(/#\d+$/, '') || 'Material';
  for (let n = 1; ; n++) {
    const candidate = `${stem}#${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Create a material in the draft (unique name, alpha clamped to 0..1). */
export function createMaterial(draft: DocumentDraft, opts: CreateMaterialOptions): Material {
  const id = allocId<MaterialId>(draft);
  const m: Material = {
    id,
    name: uniqueMaterialName(draft as unknown as DocumentState, opts.name),
    color: [clamp01(opts.color[0]), clamp01(opts.color[1]), clamp01(opts.color[2])],
    alpha: clamp01(opts.alpha ?? 1),
    texture: opts.texture ? { ...opts.texture } : null,
  };
  (draft.materials as unknown as Map<MaterialId, Material>).set(id, m);
  return (draft as unknown as DocumentState).materials.get(id)!;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** One reference to a material somewhere in the document. */
export type MaterialUse =
  | { kind: 'face'; definitionId: number; bodyId: Id; faceId: number; side: 'front' | 'back' }
  | { kind: 'sketchFace'; definitionId: number; faceId: Id; side: 'front' | 'back' }
  | { kind: 'body'; definitionId: number; bodyId: Id }
  | { kind: 'instance'; definitionId: number; instanceId: Id };

/** Every reference to `id` across all definitions (faces of bodies, sketch faces, bodies, instances). */
export function materialUses(state: DocumentState, id: MaterialId): MaterialUse[] {
  const out: MaterialUse[] = [];
  for (const def of state.definitions.values()) {
    const c = def.entities;
    for (const b of c.bodies.values()) {
      if (b.materialId === id) out.push({ kind: 'body', definitionId: def.id, bodyId: b.id });
      for (const f of b.faces.values()) {
        if (f.frontMaterialId === id) out.push({ kind: 'face', definitionId: def.id, bodyId: b.id, faceId: f.id, side: 'front' });
        if (f.backMaterialId === id) out.push({ kind: 'face', definitionId: def.id, bodyId: b.id, faceId: f.id, side: 'back' });
      }
    }
    for (const f of c.sketch.faces.values()) {
      if (f.frontMaterialId === id) out.push({ kind: 'sketchFace', definitionId: def.id, faceId: f.id, side: 'front' });
      if (f.backMaterialId === id) out.push({ kind: 'sketchFace', definitionId: def.id, faceId: f.id, side: 'back' });
    }
    for (const inst of c.instances.values()) if (inst.materialId === id) out.push({ kind: 'instance', definitionId: def.id, instanceId: inst.id });
  }
  return out;
}

/** Ids of every material referenced anywhere (the default material is always counted as used). */
export function materialsInUse(state: DocumentState): Set<MaterialId> {
  const used = new Set<MaterialId>([state.defaultMaterialId]);
  const add = (id: MaterialId | null) => {
    if (id !== null) used.add(id);
  };
  for (const def of state.definitions.values()) {
    const c = def.entities;
    for (const b of c.bodies.values()) {
      add(b.materialId);
      for (const f of b.faces.values()) {
        add(f.frontMaterialId);
        add(f.backMaterialId);
      }
    }
    for (const f of c.sketch.faces.values()) {
      add(f.frontMaterialId);
      add(f.backMaterialId);
    }
    for (const inst of c.instances.values()) add(inst.materialId);
  }
  return used;
}

/** Ids of image assets referenced by any material texture. */
export function imagesInUse(state: DocumentState): Set<number> {
  const used = new Set<number>();
  for (const m of state.materials.values()) if (m.texture) used.add(m.texture.imageId);
  for (const def of state.definitions.values()) for (const img of def.entities.images.values()) used.add(img.imageId);
  for (const s of state.styles.values()) for (const w of s.watermarks) used.add(w.imageId);
  return used;
}

/**
 * Replace every reference to `from` with `to` (null = default) in all definitions. Returns the
 * number of references rewritten.
 */
export function replaceMaterialRefs(draft: DocumentDraft, from: MaterialId, to: MaterialId | null): number {
  let n = 0;
  for (const def of draft.definitions.values()) {
    const c = def.entities;
    for (const b of c.bodies.values()) {
      if (b.materialId === from) {
        b.materialId = to;
        n++;
      }
      for (const f of b.faces.values()) {
        if (f.frontMaterialId === from) {
          f.frontMaterialId = to;
          n++;
        }
        if (f.backMaterialId === from) {
          f.backMaterialId = to;
          n++;
        }
      }
    }
    for (const f of c.sketch.faces.values()) {
      if (f.frontMaterialId === from) {
        f.frontMaterialId = to;
        n++;
      }
      if (f.backMaterialId === from) {
        f.backMaterialId = to;
        n++;
      }
    }
    for (const inst of c.instances.values()) {
      if (inst.materialId === from) {
        inst.materialId = to;
        n++;
      }
    }
  }
  return n;
}

/** Material by id, or null for the default / an unknown id. */
export function materialOrNull(state: Pick<DocumentState, 'materials' | 'defaultMaterialId'>, id: MaterialId | null | undefined): Material | null {
  if (id === null || id === undefined || id === state.defaultMaterialId) return null;
  return state.materials.get(id) ?? null;
}

/** The material a face side shows: its own, else the body's, else the inherited instance material (`inherited`). */
export function effectiveMaterialId(faceMaterialId: MaterialId | null, bodyMaterialId: MaterialId | null, inherited: MaterialId | null = null): MaterialId | null {
  return faceMaterialId ?? bodyMaterialId ?? inherited;
}
