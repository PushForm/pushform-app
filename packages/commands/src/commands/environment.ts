// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { PushFormError } from '@pushform/core';
import type { Id, StyleId } from '@pushform/core';
import {
  allocId,
  defaultSceneLight,
  environmentPreset,
  ENVIRONMENT_RANGES,
  MAX_SCENE_LIGHTS,
  MAX_SCENE_SHADOW_SAMPLES,
  sceneShadowSamples,
  validEnvironment,
  validSceneLight,
} from '@pushform/model';
import type { DocumentState, EnvironmentSettings, SceneLight, Style } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf } from '../host/services';
import { ensureDocumentImage } from './materials';

const range = (key: keyof typeof ENVIRONMENT_RANGES) =>
  z.number().finite().min(ENVIRONMENT_RANGES[key][0]).max(ENVIRONMENT_RANGES[key][1]);
export const EnvironmentPatchSchema = z
  .object({
    preset: z.enum(['bright', 'soft', 'daylight', 'night', 'custom']).optional(),
    studioEnabled: z.boolean().optional(),
    brightness: range('brightness').optional(),
    fill: range('fill').optional(),
    facing: range('facing').optional(),
    key: range('key').optional(),
    azimuth: range('azimuth').optional(),
    elevation: range('elevation').optional(),
    followCamera: z.boolean().optional(),
    studioShadows: z.boolean().optional(),
    sunEnabled: z.boolean().optional(),
    sunIntensity: range('sunIntensity').optional(),
    sunShadows: z.boolean().optional(),
    skyLight: range('skyLight').optional(),
    sky: z.enum(['solid', 'clear', 'overcast', 'night', 'image']).optional(),
    skyboxImageId: z.number().int().positive().nullable().optional(),
    skyRotation: range('skyRotation').optional(),
    sceneLightsEnabled: z.boolean().optional(),
  })
  .strict();
export type EnvironmentPatch = z.infer<typeof EnvironmentPatchSchema>;
function definedPatch<T extends object>(target: T, patch: object): T {
  for (const [key, value] of Object.entries(patch))
    if (value !== undefined)
      (target as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
  return target;
}

function activeStyle(state: DocumentState): Style {
  const style = state.styles.get(state.activeStyleId);
  if (!style) throw new PushFormError('style.missing', 'No active style');
  return style;
}
export function patchedEnvironment(style: Style, patch: EnvironmentPatch): EnvironmentSettings {
  const env = definedPatch({ ...(style.environment ?? environmentPreset('bright')) }, patch);
  if (!validEnvironment(env))
    throw new PushFormError('environment.invalid', 'Invalid environment settings');
  return env;
}

export const environmentSet = defineCommand({
  id: 'environment.set',
  title: 'Update Environment',
  category: 'view',
  undoable: true,
  params: z.object({ patch: EnvironmentPatchSchema }),
  run(ctx, { patch }): void {
    const host = hostOf(ctx);
    host.edit('Update Environment', (draft) => {
      const style = activeStyle(draft as unknown as DocumentState),
        env = patchedEnvironment(style, patch);
      if (env.sky === 'image' && env.skyboxImageId === null)
        throw new PushFormError('image.missing', 'Choose a skybox image first');
      if (env.skyboxImageId !== null)
        env.skyboxImageId = ensureDocumentImage(host, draft, env.skyboxImageId);
      style.environment = env;
    });
  },
});
export const environmentSaveStyle = defineCommand({
  id: 'environment.saveStyle',
  title: 'Save Environment as Style',
  category: 'edit',
  undoable: true,
  params: z.object({ name: z.string().trim().min(1).max(100), patch: EnvironmentPatchSchema }),
  run(ctx, { name, patch }): number {
    const host = hostOf(ctx);
    return host.edit('Save Style', (draft) => {
      const state = draft as unknown as DocumentState,
        source = activeStyle(state),
        id = allocId<StyleId>(draft);
      if ([...state.styles.values()].some((style) => style.name === name))
        throw new PushFormError('style.name', 'A style with that name already exists');
      const copy: Style = {
        ...(JSON.parse(JSON.stringify(source)) as Style),
        id,
        name,
        watermarks: source.watermarks.map((watermark) => ({ ...watermark })),
      };
      copy.environment = patchedEnvironment(source, patch);
      if (copy.environment.sky === 'image' && copy.environment.skyboxImageId === null)
        throw new PushFormError('image.missing', 'Choose a skybox image first');
      if (copy.environment.skyboxImageId !== null)
        copy.environment.skyboxImageId = ensureDocumentImage(
          host,
          draft,
          copy.environment.skyboxImageId,
        );
      state.styles.set(id, copy);
      draft.activeStyleId = id;
      return id;
    });
  },
});

const vector = z.tuple([
  z.number().finite().min(-1e9).max(1e9),
  z.number().finite().min(-1e9).max(1e9),
  z.number().finite().min(-1e9).max(1e9),
]);
export const SceneLightPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    type: z.enum(['point', 'spot', 'area']).optional(),
    position: vector.optional(),
    target: vector.optional(),
    lumens: z.number().finite().min(0).max(100000).optional(),
    temperature: z.number().finite().min(1000).max(12000).optional(),
    enabled: z.boolean().optional(),
    castShadow: z.boolean().optional(),
    angle: z.number().finite().min(1).max(178).optional(),
    penumbra: z.number().finite().min(0).max(1).optional(),
    width: z.number().finite().min(0.001).max(1000).optional(),
    height: z.number().finite().min(0.001).max(1000).optional(),
  })
  .strict();
export type SceneLightPatch = z.infer<typeof SceneLightPatchSchema>;
function validateLights(lights: readonly SceneLight[]): void {
  if (lights.length > MAX_SCENE_LIGHTS)
    throw new PushFormError('light.limit', `A model can contain up to ${MAX_SCENE_LIGHTS} lights`);
  if (lights.some((light) => !validSceneLight(light)))
    throw new PushFormError(
      'light.invalid',
      'A light needs valid settings and a target away from its position',
    );
  if (sceneShadowSamples(lights) > MAX_SCENE_SHADOW_SAMPLES)
    throw new PushFormError(
      'light.shadows',
      'Too many shadow-casting lights. Turn off shadows on another light first.',
    );
}
export const lightCreate = defineCommand({
  id: 'light.create',
  title: 'Create Scene Light',
  category: 'edit',
  undoable: true,
  params: SceneLightPatchSchema,
  run(ctx, patch): number {
    return hostOf(ctx).edit('Create Light', (draft) => {
      const state = draft as unknown as DocumentState;
      const value = definedPatch(
        { ...defaultSceneLight(patch.type), id: allocId<Id>(draft) },
        patch,
      );
      const lights = [...(state.sceneLights ?? []), value];
      validateLights(lights);
      state.sceneLights = lights;
      return value.id;
    });
  },
});
export const lightUpdate = defineCommand({
  id: 'light.update',
  title: 'Edit Scene Light',
  category: 'edit',
  undoable: true,
  params: z.object({ id: z.number().int().positive(), patch: SceneLightPatchSchema }),
  run(ctx, { id, patch }): void {
    hostOf(ctx).edit('Edit Light', (draft) => {
      const state = draft as unknown as DocumentState,
        lights = state.sceneLights ?? [];
      if (!lights.some((light) => light.id === id))
        throw new PushFormError('light.missing', 'Light not found');
      const next = lights.map((light) =>
        light.id === id ? definedPatch({ ...light }, patch) : light,
      );
      validateLights(next);
      state.sceneLights = next;
    });
  },
});
export const lightDelete = defineCommand({
  id: 'light.delete',
  title: 'Delete Scene Light',
  category: 'edit',
  undoable: true,
  params: z.object({ id: z.number().int().positive() }),
  run(ctx, { id }): void {
    hostOf(ctx).edit('Delete Light', (draft) => {
      if (!draft.sceneLights?.some((light) => light.id === id))
        throw new PushFormError('light.missing', 'Light not found');
      draft.sceneLights = draft.sceneLights.filter((light) => light.id !== id);
      if (!draft.sceneLights.length) delete draft.sceneLights;
    });
  },
});
export const lightPlace = defineCommand({
  id: 'light.place',
  title: 'Place Scene Light',
  category: 'draw',
  undoable: false,
  params: SceneLightPatchSchema,
  run(ctx, patch): void {
    if (!ctx.tools) throw new PushFormError('tool.missing', 'Light placement needs a viewport');
    ctx.services.set('sceneLightPlacement', patch);
    ctx.tools.activate('placeLight');
  },
});
export const environmentCommands: readonly AnyCommand[] = [
  environmentSet,
  environmentSaveStyle,
  lightCreate,
  lightUpdate,
  lightDelete,
  lightPlace,
];
