// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ExtensionPermission } from './vocabulary.ts';

/**
 * The parts of the runtime protocol that code inside an extension runtime needs: error codes and the error type,
 * the service table, and a structural check of host messages. Free of the schema library, so the runtime stays
 * small; the host validates runtime messages with the full schemas in `runtime.ts`.
 */

export const RUNTIME_PROTOCOL_VERSION = 1;

export const DEACTIVATION_REASONS = ['disable', 'update', 'uninstall', 'idle', 'revoked', 'shutdown'] as const;
export type DeactivationReason = (typeof DEACTIVATION_REASONS)[number];

/** Stable error codes. Messages are safe to show; no error carries host internals or another extension's ids. */
export const EXTENSION_ERROR_CODES = ['permission.denied', 'revision.stale', 'limit.exceeded', 'validation.failed',
  'cancelled', 'unavailable', 'extension.unsupported', 'extension.failed'] as const;
export type ExtensionErrorCode = (typeof EXTENSION_ERROR_CODES)[number];

/** An error as it crosses between host and runtime. */
export interface ExtensionErrorData {
  code: ExtensionErrorCode;
  message: string;
  details?: Record<string, unknown> | undefined;
}

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

/**
 * Whether a message has the shape of a host message. The host is trusted, so this only guards the runtime against
 * stray messages on its port; the host checks every runtime message against the full schema.
 */
export function isHostMessage(value: unknown): value is { type: 'activate' | 'invoke' | 'cancel' | 'response' | 'deactivate' } & Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  const int = (key: string) => Number.isSafeInteger(message[key]) && (message[key] as number) >= 0;
  switch (message.type) {
    case 'activate':
      return message.v === RUNTIME_PROTOCOL_VERSION && typeof message.extensionId === 'string' && Array.isArray(message.grants)
        && typeof message.wasm === 'boolean' && Array.isArray(message.contributions);
    case 'invoke':
      return int('invocation') && typeof message.contribution === 'string';
    case 'cancel':
      return int('invocation');
    case 'response':
      return int('id') && (message.ok === true || (message.ok === false && typeof message.error === 'object' && message.error !== null));
    case 'deactivate':
      return typeof message.reason === 'string';
    default:
      return false;
  }
}
