// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { DEFAULT_FOG } from '@pushform/model';
import type { DocumentDraft, DocumentState, FogSettings } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf } from '../host/services';

/** Fog: document-level linear fog, saved with scenes alongside the style. */

export const FogPatchSchema = z.object({
  enabled: z.boolean().optional(),
  near: z.number().min(0).optional(),
  far: z.number().min(0).optional(),
  useBackground: z.boolean().optional(),
  color: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
});
export type FogPatch = z.infer<typeof FogPatchSchema>;

const draftState = (draft: DocumentDraft): DocumentState => draft as unknown as DocumentState;

/** The document's fog, defaulting for files saved before fog existed. */
export function fogOf(state: DocumentState): FogSettings {
  return state.fog ?? DEFAULT_FOG;
}

export const fogSet = defineCommand({
  id: 'fog.set',
  title: 'Fog',
  category: 'view',
  params: z.object({ patch: FogPatchSchema }),
  undoable: true,
  run(ctx, p): FogSettings {
    const host = hostOf(ctx);
    host.edit('Fog', (draft) => {
      const state = draftState(draft);
      const cur = state.fog ?? { ...DEFAULT_FOG, color: [...DEFAULT_FOG.color] as [number, number, number] };
      const next: FogSettings = { ...cur };
      if (p.patch.enabled !== undefined) next.enabled = p.patch.enabled;
      if (p.patch.near !== undefined) next.near = p.patch.near;
      if (p.patch.far !== undefined) next.far = p.patch.far;
      if (p.patch.useBackground !== undefined) next.useBackground = p.patch.useBackground;
      if (p.patch.color !== undefined) next.color = [p.patch.color[0], p.patch.color[1], p.patch.color[2]];
      if (next.far < next.near) next.far = next.near;
      state.fog = next;
    });
    return fogOf(host.doc.state);
  },
});

export const fogToggle = defineCommand({
  id: 'fog.toggle',
  title: 'Fog',
  category: 'view',
  menu: 'View',
  params: z.object({ value: z.boolean().optional() }),
  undoable: true,
  run(ctx, p): boolean {
    const host = hostOf(ctx);
    const next = p.value ?? !fogOf(host.doc.state).enabled;
    host.edit(next ? 'Show Fog' : 'Hide Fog', (draft) => {
      const state = draftState(draft);
      state.fog = { ...fogOf(state), enabled: next };
    });
    return next;
  },
});

export const fogGet = defineCommand({
  id: 'fog.get',
  title: 'Fog Settings',
  category: 'internal',
  params: z.object({}),
  undoable: false,
  run: (ctx): FogSettings => fogOf(hostOf(ctx).doc.state),
});

export const fogCommands: readonly AnyCommand[] = [fogSet, fogToggle, fogGet];
