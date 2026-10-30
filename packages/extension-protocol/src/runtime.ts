// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { EXTENSION_PERMISSIONS, type ExtensionPermission } from './manifest.ts';

/**
 * Lifecycle protocol between the host and one extension runtime. The runtime imports the package's single entry
 * module and reports `ready`; nothing else runs until the host sends `activate`, which happens only on the first
 * user action or declared event that needs the extension. After that the host sends invocations of contributions
 * and responses to service requests, and the runtime sends service requests and invocation results. Every message
 * from the runtime is untrusted and validated by the host before anything else happens.
 */

export const RUNTIME_PROTOCOL_VERSION = 1;

/** Stable error codes. Messages are safe to show; no error carries host internals or another extension's ids. */
export const EXTENSION_ERROR_CODES = ['permission.denied', 'revision.stale', 'limit.exceeded', 'validation.failed',
  'cancelled', 'unavailable', 'extension.unsupported', 'extension.failed'] as const;
export type ExtensionErrorCode = (typeof EXTENSION_ERROR_CODES)[number];

export const extensionErrorSchema = z.strictObject({
  code: z.enum(EXTENSION_ERROR_CODES),
  message: z.string().max(500),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ExtensionErrorData = z.infer<typeof extensionErrorSchema>;

/** A structured failure of a host call or an extension handler. */
export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  constructor(code: ExtensionErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ExtensionError';
    this.code = code;
    this.details = details;
  }
  toJSON(): ExtensionErrorData {
    return { code: this.code, message: this.message.slice(0, 500), ...(this.details ? { details: { ...this.details } } : {}) };
  }
  static from(data: ExtensionErrorData): ExtensionError {
    return new ExtensionError(data.code, data.message, data.details);
  }
}

/**
 * Host services reachable from `context`, with the permission each method needs. A service appears on `context`
 * only when at least one of its methods is allowed; a method whose permission was not granted fails with
 * `permission.denied` naming the permission. `null` means no permission beyond the extension being active.
 * `compute` and `wasm` exist only for packages that declare WASM modules.
 */
export const EXTENSION_SERVICES = {
  ui: { mount: null, update: null, unmount: null },
  model: { read: 'model.read', query: 'model.read', subscribe: 'model.read', apply: 'model.write' },
  selection: { get: 'selection.read', set: 'selection.write', frame: 'viewport.presentation' },
  settings: { get: 'settings', set: 'settings' },
  files: { open: 'file.read', save: 'file.export' },
  clipboard: { write: 'clipboard.write' },
  http: { fetch: 'network' },
  compute: { run: null },
  wasm: { load: null },
  log: { write: null },
} as const satisfies Record<string, Record<string, ExtensionPermission | null>>;
export type ExtensionServiceName = keyof typeof EXTENSION_SERVICES;
export type ExtensionServiceMethod<S extends ExtensionServiceName> = keyof (typeof EXTENSION_SERVICES)[S] & string;
export const WASM_SERVICES: ReadonlySet<ExtensionServiceName> = new Set(['compute', 'wasm']);

/** The permission one service method needs, `null` when none, or `undefined` when there is no such method. */
export function methodPermission(service: string, method: string): ExtensionPermission | null | undefined {
  const methods = (EXTENSION_SERVICES as Record<string, Record<string, ExtensionPermission | null>>)[service];
  return methods && Object.hasOwn(methods, method) ? methods[method] : undefined;
}

/** What the runtime may use, given the granted permissions and whether the package declares WASM modules. */
export interface ServiceAccess {
  readonly grants: ReadonlySet<ExtensionPermission>;
  readonly wasm: boolean;
}

/** Whether `service` appears on `context`: some method is allowed, and WASM services need declared modules. */
export function serviceAvailable(service: ExtensionServiceName, access: ServiceAccess): boolean {
  if (WASM_SERVICES.has(service) && !access.wasm) return false;
  return Object.values(EXTENSION_SERVICES[service]).some((p: ExtensionPermission | null) => p === null || access.grants.has(p));
}

/** The permission that would make an unavailable service appear, for the error that names it. */
export function servicePermissions(service: ExtensionServiceName): ExtensionPermission[] {
  const permissions: (ExtensionPermission | null)[] = Object.values(EXTENSION_SERVICES[service]);
  return [...new Set(permissions.filter((p): p is ExtensionPermission => p !== null))];
}

const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const contributionId = z.string().min(1).max(200);
export const DEACTIVATION_REASONS = ['disable', 'update', 'uninstall', 'idle', 'revoked', 'shutdown'] as const;
export type DeactivationReason = (typeof DEACTIVATION_REASONS)[number];

/** Host to runtime. A plain union: `response` and `result` each have an ok and an error shape. */
export const hostMessageSchema = z.union([
  z.strictObject({ type: z.literal('activate'), v: z.literal(RUNTIME_PROTOCOL_VERSION), extensionId: z.string().max(200),
    grants: z.array(z.enum(EXTENSION_PERMISSIONS)), wasm: z.boolean(), contributions: z.array(contributionId) }),
  z.strictObject({ type: z.literal('invoke'), invocation: id, contribution: contributionId, params: z.unknown() }),
  z.strictObject({ type: z.literal('cancel'), invocation: id }),
  z.strictObject({ type: z.literal('response'), id, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ type: z.literal('response'), id, ok: z.literal(false), error: extensionErrorSchema }),
  z.strictObject({ type: z.literal('deactivate'), reason: z.enum(DEACTIVATION_REASONS) }),
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
