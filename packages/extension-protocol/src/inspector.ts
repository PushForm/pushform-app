// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { metadataTargetSchema } from './metadata.ts';

export const inspectorDeclarationSchema = z.strictObject({
  targets: z.array(z.enum(['bodyOccurrence', 'body', 'group', 'instance', 'definition'])).min(1).max(5),
  multiSelection: z.enum(['none', 'homogeneous', 'mixed']).default('none'),
}).refine(value => new Set(value.targets).size === value.targets.length, 'Inspector target kinds must be distinct');
/** Host-created edit context. Its binding is revoked when its Entity Info view changes. */
export const inspectorCaptureSchema = z.strictObject({
  binding: z.string().min(1).max(100), revision: z.number().int().nonnegative(),
  scope: z.enum(['placement', 'shared']), targets: z.array(metadataTargetSchema).min(1).max(200),
  placementCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  overrideCount: z.number().int().nonnegative(),
}).refine(value => value.scope === 'shared' || !value.targets.some(target => target.kind === 'body'), 'Shared body targets require an explicit shared scope');
export type InspectorCapture = z.infer<typeof inspectorCaptureSchema>;
export type InspectorDeclaration = z.infer<typeof inspectorDeclarationSchema>;
