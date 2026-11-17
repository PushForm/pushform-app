// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';

/** A length in meters. */
export const length = z.number().finite().positive();
/** A position in meters, in the coordinates of the batch's container. */
export const position = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** What a client needs to call a builder. `example` must generate on an empty model. */
export interface ModelBuilderSpec<S extends z.ZodType = z.ZodType> {
  /** One line, shown to AI Chat on every message, so keep it short. */
  readonly summary: string;
  /** When to reach for it, and what it does not do. Sent only when a client asks about this builder. */
  readonly guidance: string;
  readonly schema: S;
  readonly example: z.input<S>;
}

export const defineBuilder = <S extends z.ZodType>(spec: ModelBuilderSpec<S>): ModelBuilderSpec<S> => spec;
