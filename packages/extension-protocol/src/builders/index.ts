// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { countertopBuilder } from './countertop';

/** Every builder the `build` operation serves. Adding one here is what makes a client able to ask for it. */
export const MODEL_BUILDERS = {
  countertop: countertopBuilder,
} as const;

export type ModelBuilderKey = keyof typeof MODEL_BUILDERS;
export type ModelBuilderParams<K extends ModelBuilderKey> = z.infer<(typeof MODEL_BUILDERS)[K]['schema']>;
export const MODEL_BUILDER_KEYS = Object.keys(MODEL_BUILDERS) as [ModelBuilderKey, ...ModelBuilderKey[]];

/** The parameters and guidance a client reads before calling one builder. */
export function modelBuilderInfo(key: ModelBuilderKey): { builder: ModelBuilderKey; summary: string; guidance: string; parameters: unknown; example: unknown } {
  const spec = MODEL_BUILDERS[key];
  return { builder: key, summary: spec.summary, guidance: spec.guidance, parameters: z.toJSONSchema(spec.schema), example: spec.example };
}

/** One line per builder, for the description of the tool that explains them. */
export const modelBuilderList = (): string => MODEL_BUILDER_KEYS.map(key => `${key}: ${MODEL_BUILDERS[key].summary}`).join('; ');

export { defineBuilder, hexColor, length, position, type ModelBuilderSpec } from './spec';
