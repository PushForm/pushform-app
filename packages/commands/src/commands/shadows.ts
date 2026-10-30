// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { DEFAULT_SHADOWS } from '@pushform/model';
import type { DocumentDraft, DocumentState, ShadowSettings } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf } from '../host/services';

/**
 * Shadows: document-level sun settings (date, time, UTC offset, location,
 * light/dark, display flags). The render package turns them into a sun direction through the NOAA
 * solar position and a directional shadow light.
 */

export const ShadowPatchSchema = z.object({
  enabled: z.boolean().optional(),
  month: z.number().int().min(1).max(12).optional(),
  day: z.number().int().min(1).max(31).optional(),
  /** Minutes since midnight (local). */
  time: z.number().min(0).max(24 * 60 - 1).optional(),
  utcOffsetHours: z.number().min(-12).max(14).optional(),
  light: z.number().min(0).max(100).optional(),
  dark: z.number().min(0).max(100).optional(),
  useSunForShading: z.boolean().optional(),
  onFaces: z.boolean().optional(),
  onGround: z.boolean().optional(),
  fromEdges: z.boolean().optional(),
});
export type ShadowPatch = z.infer<typeof ShadowPatchSchema>;

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Day of year (1..366) of a month/day pair (leap-year month lengths so Feb 29 is addressable). */
export function dayOfYear(month: number, day: number): number {
  let n = 0;
  for (let m = 1; m < month; m++) n += DAYS_IN_MONTH[m - 1]!;
  return n + day;
}

/** Inverse of `dayOfYear`. */
export function monthDayOf(dayOfYearValue: number): { month: number; day: number } {
  let d = Math.max(1, Math.min(366, Math.round(dayOfYearValue)));
  for (let m = 1; m <= 12; m++) {
    const len = DAYS_IN_MONTH[m - 1]!;
    if (d <= len) return { month: m, day: d };
    d -= len;
  }
  return { month: 12, day: 31 };
}

/** Clamp `day` to its month. */
export function clampDay(month: number, day: number): number {
  return Math.max(1, Math.min(DAYS_IN_MONTH[month - 1]!, Math.round(day)));
}

const draftState = (draft: DocumentDraft): DocumentState => draft as unknown as DocumentState;

export const shadowsSet = defineCommand({
  id: 'shadows.set',
  title: 'Shadow Settings',
  category: 'view',
  params: z.object({ patch: ShadowPatchSchema }),
  undoable: true,
  run(ctx, p): ShadowSettings {
    const host = hostOf(ctx);
    host.edit('Shadow Settings', (draft) => {
      const s = draftState(draft).shadows;
      for (const [k, v] of Object.entries(p.patch)) if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = v;
      s.day = clampDay(s.month, s.day);
    });
    return host.doc.state.shadows;
  },
});

export const shadowsSetLocation = defineCommand({
  id: 'shadows.setLocation',
  title: 'Shadow Location',
  category: 'view',
  params: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), northAngle: z.number().optional() }),
  undoable: true,
  run(ctx, p): ShadowSettings {
    const host = hostOf(ctx);
    host.edit('Geo-location', (draft) => {
      const s = draftState(draft).shadows;
      s.latitude = p.latitude;
      s.longitude = p.longitude;
      if (p.northAngle !== undefined) s.northAngle = ((p.northAngle % 360) + 360) % 360;
    });
    return host.doc.state.shadows;
  },
});

export const shadowsToggle = defineCommand({
  id: 'shadows.toggle',
  title: 'Shadows',
  category: 'view',
  menu: 'View',
  params: z.object({ value: z.boolean().optional() }),
  undoable: true,
  run(ctx, p): boolean {
    const host = hostOf(ctx);
    const next = p.value ?? !host.doc.state.shadows.enabled;
    host.edit(next ? 'Show Shadows' : 'Hide Shadows', (draft) => {
      draftState(draft).shadows.enabled = next;
    });
    return next;
  },
});

export const shadowsReset = defineCommand({
  id: 'shadows.reset',
  title: 'Reset Shadows',
  category: 'view',
  params: z.object({}),
  undoable: true,
  run(ctx): void {
    hostOf(ctx).edit('Reset Shadows', (draft) => {
      draft.shadows = { ...DEFAULT_SHADOWS };
    });
  },
});

export const shadowsGet = defineCommand({
  id: 'shadows.get',
  title: 'Shadow Settings',
  category: 'internal',
  params: z.object({}),
  undoable: false,
  run: (ctx): ShadowSettings => hostOf(ctx).doc.state.shadows,
});

export const shadowCommands: readonly AnyCommand[] = [shadowsSet, shadowsSetLocation, shadowsToggle, shadowsReset, shadowsGet];
