// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { DEACTIVATION_REASONS, EXTENSION_ERROR_CODES, RUNTIME_PROTOCOL_VERSION, type ExtensionErrorData } from './runtimeCore.ts';
import { EXTENSION_PERMISSIONS } from './vocabulary.ts';

/**
 * Lifecycle protocol between the host and one extension runtime. The runtime imports the package's single entry
 * module and reports `ready`; nothing else runs until the host sends `activate`, which happens only on the first
 * user action or declared event that needs the extension. After that the host sends invocations of contributions
 * and responses to service requests, and the runtime sends service requests and invocation results. Every message
 * from the runtime is untrusted and validated by the host before anything else happens.
 */

const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const contributionId = z.string().min(1).max(200);
export const extensionErrorSchema = z.strictObject({
  code: z.enum(EXTENSION_ERROR_CODES),
  message: z.string().max(500),
  details: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<ExtensionErrorData>;

/** Host to runtime. A plain union: `response` and `result` each have an ok and an error shape. */
export const hostMessageSchema = z.union([
  z.strictObject({ type: z.literal('activate'), v: z.literal(RUNTIME_PROTOCOL_VERSION), extensionId: z.string().max(200),
    grants: z.array(z.enum(EXTENSION_PERMISSIONS)), wasm: z.boolean(), contributions: z.array(contributionId) }),
  z.strictObject({ type: z.literal('invoke'), invocation: id, contribution: contributionId, params: z.unknown(),
    /** The host-issued handle of the document the invocation acts on, when it has one. */
    document: z.string().max(100).optional() }),
  z.strictObject({ type: z.literal('cancel'), invocation: id }),
  z.strictObject({ type: z.literal('response'), id, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ type: z.literal('response'), id, ok: z.literal(false), error: extensionErrorSchema }),
  z.strictObject({ type: z.literal('deactivate'), reason: z.enum(DEACTIVATION_REASONS) }),
  /** Progress of a running host call, with the best partial result so far when the service has one. */
  z.strictObject({ type: z.literal('progress'), id, value: z.number().min(0).max(1).nullable(), partial: z.unknown().optional() }),
  /** A user event on a mounted interface (see `ui.ts`): the target, the component, the event and its payload. */
  z.object({ type: z.literal('event'), target: z.string().max(200), component: z.string().max(100), event: z.string().max(40) }).loose(),
]);
export type HostMessage = z.infer<typeof hostMessageSchema>;

/** Runtime to host. */
export const runtimeMessageSchema = z.union([
  z.strictObject({ type: z.literal('ready'), v: z.literal(RUNTIME_PROTOCOL_VERSION) }),
  z.strictObject({ type: z.literal('load-failed'), error: extensionErrorSchema }),
  z.strictObject({ type: z.literal('activated') }),
  z.strictObject({ type: z.literal('activation-failed'), error: extensionErrorSchema }),
  z.strictObject({ type: z.literal('request'), id, service: z.string().max(40), method: z.string().max(40), input: z.unknown() }),
  z.strictObject({ type: z.literal('cancel-request'), id }),
  z.strictObject({ type: z.literal('result'), invocation: id, ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ type: z.literal('result'), invocation: id, ok: z.literal(false), error: extensionErrorSchema }),
  z.strictObject({ type: z.literal('deactivated') }),
]);
export type RuntimeMessage = z.infer<typeof runtimeMessageSchema>;
