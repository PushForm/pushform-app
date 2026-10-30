// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { typedLengthUnit } from '@pushform/core';
import type { DefId, ImageId, MaterialId, StyleId, UnitSettings } from '@pushform/core';
import { imagesInUse, materialsInUse } from '@pushform/model';
import type { DocumentDraft, DocumentState } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { activeMaterialOf, displayOf, hostOf } from '../host/services';
import { purgeUnusedTags } from './tags';

/** Model Info: the model's display units and Purge Unused. */

const precision = (max: number) => z.number().int().min(0).max(max);

export const UnitsPatchSchema = z.object({
  format: z.enum(['architectural', 'decimal', 'engineering', 'fractional']).optional(),
  lengthUnit: z.enum(['in', 'ft', 'yd', 'mm', 'cm', 'm']).optional(),
  lengthPrecision: precision(6).optional(),
  areaUnit: z.enum(['in²', 'ft²', 'yd²', 'mm²', 'cm²', 'm²']).optional(),
  areaPrecision: precision(6).optional(),
  volumeUnit: z.enum(['in³', 'ft³', 'yd³', 'mm³', 'cm³', 'm³', 'l']).optional(),
  volumePrecision: precision(6).optional(),
  /** Snap length in meters, or null to turn length snapping off. */
  lengthSnap: z.number().positive().nullable().optional(),
  /** Snap angle in degrees, or null to turn angle snapping off. */
  angleSnap: z.number().positive().max(180).nullable().optional(),
  anglePrecision: precision(3).optional(),
  displayUnitSuffix: z.boolean().optional(),
  forceZeroInches: z.boolean().optional(),
});
export type UnitsPatch = z.infer<typeof UnitsPatchSchema>;

const draftState = (draft: DocumentDraft): DocumentState => draft as unknown as DocumentState;

/**
 * Changes the model's display units as one undoable step. Architectural and fractional lengths are always
 * in inches and engineering lengths in feet, so those formats set the length unit.
 */
export const modelSetUnits = defineCommand({
  id: 'model.setUnits',
  title: 'Model Units',
  category: 'edit',
  params: z.object({ patch: UnitsPatchSchema }),
  undoable: true,
  run(ctx, p): UnitSettings {
    const host = hostOf(ctx);
    host.edit('Model Units', (draft) => {
      const state = draftState(draft);
      const next: UnitSettings = { ...state.meta.units };
      for (const [key, value] of Object.entries(p.patch)) if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
      if (next.format !== 'decimal') next.lengthUnit = typedLengthUnit(next);
      const cur = state.meta.units;
      if ((Object.keys(next) as (keyof UnitSettings)[]).some((key) => next[key] !== cur[key])) state.meta.units = next;
    });
    return host.doc.state.meta.units;
  },
});

/** What Purge Unused removed. */
export interface PurgeUnusedResult {
  /** Group and component definitions placed nowhere in the model. */
  definitions: number;
  styles: number;
  /** Tags and empty tag folders. */
  tags: number;
  materials: number;
  images: number;
}

/** Removes, inside an edit, everything the model does not use, in the order gives. */
export function purgeUnused(state: DocumentState): PurgeUnusedResult {
  const placed = new Set<DefId>([state.rootDefinitionId]);
  const stack = [state.rootDefinitionId];
  while (stack.length) {
    const def = state.definitions.get(stack.pop()!);
    for (const instance of def?.entities.instances.values() ?? []) {
      if (placed.has(instance.definitionId)) continue;
      placed.add(instance.definitionId);
      stack.push(instance.definitionId);
    }
  }
  const result: PurgeUnusedResult = { definitions: 0, styles: 0, tags: 0, materials: 0, images: 0 };
  for (const id of [...state.definitions.keys()]) if (!placed.has(id)) { state.definitions.delete(id); result.definitions++; }
  const styles = new Set<StyleId>([state.activeStyleId]);
  for (const scene of state.scenes.values()) if (scene.styleId !== null) styles.add(scene.styleId);
  for (const id of [...state.styles.keys()]) if (!styles.has(id)) { state.styles.delete(id); result.styles++; }
  result.tags = purgeUnusedTags(state);
  const materials = materialsInUse(state);
  for (const id of [...state.materials.keys()]) if (!materials.has(id)) { state.materials.delete(id); result.materials++; }
  const images = imagesInUse(state);
  for (const id of [...state.images.keys()]) if (!images.has(id as number)) { state.images.delete(id as ImageId); result.images++; }
  return result;
}

/** Purge Unused: one undoable step; nothing to remove changes nothing. */
export const modelPurgeUnused = defineCommand({
  id: 'model.purgeUnused',
  title: 'Purge Unused',
  category: 'edit',
  params: z.object({}),
  undoable: true,
  run(ctx): PurgeUnusedResult {
    const material = activeMaterialOf(ctx), display = displayOf(ctx);
    const activeMaterial = material.get(), activeTag = display.get().activeTagId;
    let materialGone = false, tagGone = false;
    const result = hostOf(ctx).edit('Purge Unused', (draft) => {
      const state = draftState(draft);
      const purged = purgeUnused(state);
      // The command's own transaction commits after `run`, so check what the purge removed here.
      materialGone = activeMaterial !== null && !state.materials.has(activeMaterial as MaterialId);
      tagGone = activeTag !== null && !state.tags.has(activeTag as never);
      return purged;
    });
    if (materialGone) material.set(null);
    if (tagGone) display.set({ activeTagId: null });
    return result;
  },
});

export const modelInfoCommands: readonly AnyCommand[] = [modelSetUnits, modelPurgeUnused];
