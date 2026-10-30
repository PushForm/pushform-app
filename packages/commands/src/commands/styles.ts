// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { PushFormError } from '@pushform/core';
import type { StyleId } from '@pushform/core';
import { allocId, createDefaultStyle } from '@pushform/model';
import type { DocumentDraft, DocumentState, Style } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import type { DocumentHost } from '../host/DocumentHost';
import { hostOf } from '../host/services';
import type { DisplayKey, DisplayState } from '../host/DisplayHost';

/**
 * Styles v1: the active style is the single source for edge, face,
 * background and modeling display; `displayToRender` / `backgroundToRender` in the UI adapter map
 * it to the viewport. `view.*` toggles patch the active style through `styleDisplayPatch` so the
 * Display panel and the Styles › Edit tab never disagree.
 */

// ---------------------------------------------------------------------------------------------
// Deep partial patch

const rgb = z.tuple([z.number(), z.number(), z.number()]);
const idSchema = z.number().int().nonnegative();

export const StylePatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  edges: z
    .object({
      edges: z.boolean().optional(),
      profiles: z.boolean().optional(),
      profileWidth: z.number().min(1).max(10).optional(),
      depthCue: z.boolean().optional(),
      depthCueLevels: z.number().min(1).max(10).optional(),
      extension: z.boolean().optional(),
      extensionLength: z.number().min(1).max(20).optional(),
      endpoints: z.boolean().optional(),
      endpointLength: z.number().min(1).max(20).optional(),
      jitter: z.boolean().optional(),
      backEdges: z.boolean().optional(),
      color: rgb.optional(),
      colorMode: z.enum(['allSame', 'byMaterial', 'byAxis']).optional(),
    })
    .optional(),
  faces: z
    .object({
      mode: z.enum(['wireframe', 'hiddenLine', 'shaded', 'shadedWithTextures', 'monochrome', 'xray']).optional(),
      frontColor: rgb.optional(),
      backColor: rgb.optional(),
      xrayOpacity: z.number().min(0).max(1).optional(),
      /** Transparency quality: faster / medium / nicer (kept on the style for scripts; the renderer sorts transparent faces in every mode). */
      transparencyQuality: z.enum(['faster', 'medium', 'nicer']).optional(),
    })
    .optional(),
  background: z
    .object({
      color: rgb.optional(),
      sky: z.boolean().optional(),
      skyColor: rgb.optional(),
      ground: z.boolean().optional(),
      groundColor: rgb.optional(),
      groundTransparency: z.number().min(0).max(1).optional(),
      showGroundFromBelow: z.boolean().optional(),
    })
    .optional(),
  modeling: z
    .object({
      selected: rgb.optional(),
      locked: rgb.optional(),
      guides: rgb.optional(),
      inactiveSection: rgb.optional(),
      activeSection: rgb.optional(),
      sectionFill: rgb.optional(),
      sectionLine: rgb.optional(),
      sectionLineWidth: z.number().optional(),
      sectionFillEnabled: z.boolean().optional(),
      hiddenGeometry: z.boolean().optional(),
      guidesVisible: z.boolean().optional(),
      sectionPlanesVisible: z.boolean().optional(),
      sectionCutsVisible: z.boolean().optional(),
      modelAxesVisible: z.boolean().optional(),
      colorByTag: z.boolean().optional(),
    })
    .optional(),
});
export type StylePatch = z.infer<typeof StylePatchSchema>;

const draftState = (draft: DocumentDraft): DocumentState => draft as unknown as DocumentState;

export function styleOf(state: DocumentState, id: number): Style {
  const s = state.styles.get(id as StyleId);
  if (!s) throw new PushFormError('style.missing', `Style ${id} not found`);
  return s;
}

/** Copy the defined fields of `patch` onto `style` (nested one level: edges/faces/background/modeling). */
export function applyStylePatch(style: Style, patch: StylePatch): void {
  if (patch.name !== undefined) style.name = patch.name;
  if (patch.description !== undefined) style.description = patch.description;
  for (const section of ['edges', 'faces', 'background', 'modeling'] as const) {
    const p = patch[section];
    if (!p) continue;
    const target = style[section] as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      target[k] = Array.isArray(v) ? [...v] : v;
    }
  }
}

/** `base`, `base 1`, `base 2`, … not used by another style. */
export function uniqueStyleName(state: DocumentState, base: string): string {
  const taken = new Set<string>();
  for (const s of state.styles.values()) taken.add(s.name);
  if (!taken.has(base)) return base;
  for (let n = 1; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

const cloneStyle = (s: Style, id: StyleId): Style => ({ ...(JSON.parse(JSON.stringify(s)) as Style), id });

/**
 * Edit the active style in place without an undo entry (display toggles are view state). The document still emits `change`, so the viewport and panels refresh.
 */
export function patchActiveStyle(host: DocumentHost, label: string, fn: (style: Style) => void): void {
  host.doc.transact(label, (draft) => {
    const style = draftState(draft).styles.get(draft.activeStyleId);
    if (style) fn(style);
  });
}

// ---------------------------------------------------------------------------------------------
// Display ↔ style bridge

/** The display toggles the active style expresses (what the Display panel should show). */
export function displayFromStyle(style: Style): Omit<DisplayState, 'activeTagId'> {
  const mode = style.faces.mode;
  return {
    hiddenGeometry: style.modeling.hiddenGeometry,
    edges: style.edges.edges,
    profiles: style.edges.profiles,
    guides: style.modeling.guidesVisible,
    axes: style.modeling.modelAxesVisible,
    backEdges: style.edges.backEdges && mode !== 'xray',
    xray: mode === 'xray',
    faceStyle:
      mode === 'wireframe' ? 'wireframe'
      : mode === 'hiddenLine' ? 'hiddenLine'
      : mode === 'monochrome' ? 'monochrome'
      : mode === 'shaded' ? 'shaded'
      : 'shadedTextures',
  };
}

/**
 * Mutate `style` for one display toggle (`view.set`). X-ray is a face mode on the style, so
 * turning it on remembers nothing: turning it off returns to shaded-with-textures.
 */
export function styleDisplayPatch(style: Style, key: DisplayKey, value: boolean | string): void {
  switch (key) {
    case 'hiddenGeometry':
      style.modeling.hiddenGeometry = value === true;
      break;
    case 'edges':
      style.edges.edges = value === true;
      break;
    case 'profiles':
      style.edges.profiles = value === true;
      break;
    case 'guides':
      style.modeling.guidesVisible = value === true;
      break;
    case 'axes':
      style.modeling.modelAxesVisible = value === true;
      break;
    case 'backEdges':
      style.edges.backEdges = value === true;
      if (value === true && style.faces.mode === 'xray') style.faces.mode = 'shadedWithTextures';
      break;
    case 'xray':
      if (value === true) {
        style.faces.mode = 'xray';
        style.edges.backEdges = false;
      } else if (style.faces.mode === 'xray') style.faces.mode = 'shadedWithTextures';
      break;
    case 'faceStyle':
      style.faces.mode =
        value === 'wireframe' ? 'wireframe'
        : value === 'hiddenLine' ? 'hiddenLine'
        : value === 'monochrome' ? 'monochrome'
        : value === 'shaded' ? 'shaded'
        : 'shadedWithTextures';
      break;
  }
}

// ---------------------------------------------------------------------------------------------
// Presets

export interface StylePreset {
  readonly name: string;
  readonly description: string;
  /** Derive the preset from a fresh default style. */
  readonly build: (s: Style) => void;
}

export const STYLE_PRESETS: readonly StylePreset[] = [
  { name: 'Default', description: 'Shaded with textures, profiles, white sky and ground.', build: () => {} },
  {
    name: 'Simple',
    description: 'Shaded, thin edges, no profiles, plain background.',
    build: (s) => {
      s.edges.profiles = false;
      s.faces.mode = 'shaded';
      s.background.sky = false;
      s.background.ground = false;
      s.background.color = [0.93, 0.94, 0.96];
    },
  },
  {
    name: 'Sketchy-lite',
    description: 'Jittered pencil-like edges with extensions and endpoints.',
    build: (s) => {
      s.edges.jitter = true;
      s.edges.extension = true;
      s.edges.extensionLength = 4;
      s.edges.endpoints = true;
      s.edges.profileWidth = 3;
      s.edges.color = [0.12, 0.1, 0.08];
      s.faces.frontColor = [0.98, 0.97, 0.94];
      s.background.sky = false;
      s.background.ground = false;
      s.background.color = [0.97, 0.96, 0.93];
    },
  },
  {
    name: 'Hidden Line',
    description: 'Faces in the background color; only edges and profiles.',
    build: (s) => {
      s.faces.mode = 'hiddenLine';
      s.background.sky = false;
      s.background.ground = false;
      s.background.color = [1, 1, 1];
    },
  },
  {
    name: 'Monochrome',
    description: 'Front faces white, back faces blue-grey, no materials.',
    build: (s) => {
      s.faces.mode = 'monochrome';
      s.background.sky = false;
      s.background.ground = false;
      s.background.color = [0.96, 0.96, 0.96];
    },
  },
  {
    name: 'X-ray blueprint',
    description: 'Transparent faces, light edges on a blueprint background.',
    build: (s) => {
      s.faces.mode = 'xray';
      s.faces.frontColor = [0.75, 0.85, 1];
      s.faces.backColor = [0.6, 0.72, 0.95];
      s.edges.color = [0.92, 0.96, 1];
      s.edges.profileWidth = 2;
      s.background.sky = false;
      s.background.ground = false;
      s.background.color = [0.08, 0.2, 0.45];
      s.modeling.guides = [0.8, 0.85, 0.95];
    },
  },
];

export function presetStyle(name: string, id: StyleId): Style {
  const preset = STYLE_PRESETS.find((p) => p.name === name);
  if (!preset) throw new PushFormError('style.preset', `Unknown style preset: ${name}`);
  const s = createDefaultStyle(id);
  s.name = preset.name;
  s.description = preset.description;
  preset.build(s);
  return s;
}

/** In-model style of a preset name (exact name match), if any. */
export function findStyleByName(state: DocumentState, name: string): Style | undefined {
  for (const s of state.styles.values()) if (s.name === name) return s;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Commands

/** Create a style: from the active style (default), from another style id, or from a preset name. */
export const styleCreate = defineCommand({
  id: 'style.create',
  title: 'Create Style',
  category: 'edit',
  params: z.object({ name: z.string().optional(), from: z.union([idSchema, z.string()]).optional(), activate: z.boolean().default(true) }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    return host.edit('Create Style', (draft) => {
      const state = draftState(draft);
      const id = allocId<StyleId>(draft);
      let style: Style;
      if (typeof p.from === 'string') style = presetStyle(p.from, id);
      else style = cloneStyle(styleOf(state, p.from ?? state.activeStyleId), id);
      style.name = uniqueStyleName(state, p.name ?? (typeof p.from === 'string' ? style.name : `${style.name} copy`));
      state.styles.set(id, style);
      if (p.activate) draft.activeStyleId = id;
      return id as number;
    });
  },
});

export const styleUpdate = defineCommand({
  id: 'style.update',
  title: 'Edit Style',
  category: 'edit',
  params: z.object({ id: idSchema.optional(), patch: StylePatchSchema }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit('Edit Style', (draft) => {
      const state = draftState(draft);
      applyStylePatch(styleOf(state, p.id ?? state.activeStyleId), p.patch);
    });
  },
});

export const styleDelete = defineCommand({
  id: 'style.delete',
  title: 'Delete Style',
  category: 'edit',
  params: z.object({ id: idSchema }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit('Delete Style', (draft) => {
      const state = draftState(draft);
      styleOf(state, p.id);
      if (state.styles.size <= 1) throw new PushFormError('style.last', 'The last style cannot be deleted');
      state.styles.delete(p.id as StyleId);
      if (state.activeStyleId === p.id) state.activeStyleId = state.styles.keys().next().value!;
      for (const s of state.scenes.values()) if (s.styleId === p.id) s.styleId = null;
    });
  },
});

export const styleSetActive = defineCommand({
  id: 'style.setActive',
  title: 'Select Style',
  category: 'view',
  params: z.object({ id: idSchema }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit('Select Style', (draft) => {
      styleOf(draftState(draft), p.id);
      draft.activeStyleId = p.id as StyleId;
    });
  },
});

/** Reset the active style (or `id`) to the built-in default look, keeping its name. */
export const styleResetToDefault = defineCommand({
  id: 'style.resetToDefault',
  title: 'Reset Style',
  category: 'edit',
  params: z.object({ id: idSchema.optional() }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit('Reset Style', (draft) => {
      const state = draftState(draft);
      const id = (p.id ?? state.activeStyleId) as StyleId;
      const cur = styleOf(state, id);
      const fresh = createDefaultStyle(id);
      fresh.name = cur.name;
      state.styles.set(id, fresh);
    });
  },
});

/** Activate a preset: creates it in the model on demand (by name), then selects it. */
export const styleUsePreset = defineCommand({
  id: 'style.usePreset',
  title: 'Use Style Preset',
  category: 'view',
  params: z.object({ name: z.string() }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const existing = findStyleByName(host.doc.state, p.name);
    if (existing) {
      host.edit('Select Style', (draft) => {
        draft.activeStyleId = existing.id;
      });
      return existing.id as number;
    }
    return host.edit('Use Style Preset', (draft) => {
      const id = allocId<StyleId>(draft);
      draftState(draft).styles.set(id, presetStyle(p.name, id));
      draft.activeStyleId = id;
      return id as number;
    });
  },
});

export const styleList = defineCommand({
  id: 'style.list',
  title: 'Styles',
  category: 'internal',
  params: z.object({}),
  undoable: false,
  run(ctx): { inModel: { id: number; name: string; active: boolean }[]; presets: string[] } {
    const state = hostOf(ctx).doc.state;
    const inModel = [...state.styles.values()].map((s) => ({ id: s.id as number, name: s.name, active: s.id === state.activeStyleId }));
    return { inModel, presets: STYLE_PRESETS.map((p) => p.name) };
  },
});

export const styleCommands: readonly AnyCommand[] = [styleCreate, styleUpdate, styleDelete, styleSetActive, styleResetToDefault, styleUsePreset, styleList];
