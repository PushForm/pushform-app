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
  'cancelled', 'unavailable', 'extension.unsupported', 'extension.failed', 'document.closed'] as const;
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
 *
 * `model`, `selection` and `document` act on one open document: the one a call's `document` handle names, or else
 * the document of the extension's latest invocation that acts on one (the panel or command the user just used).
 */
export const EXTENSION_SERVICES = {
  ui: { mount: null, update: null, unmount: null, export: 'file.export', print: 'file.export' },
  model: { read: 'model.read', query: 'model.read', subscribe: 'model.read', apply: 'model.write' },
  selection: { get: 'selection.read', set: 'selection.write', frame: 'viewport.presentation' },
  document: { units: null },
  settings: { get: 'settings', set: 'settings' },
  files: { open: 'file.read', save: 'file.export' },
  clipboard: { write: 'clipboard.write' },
  http: { fetch: 'network' },
  compute: { run: null },
  wasm: { load: null, call: null, unload: null },
  log: { write: null },
} as const satisfies Record<string, Record<string, ExtensionPermission | null>>;
export type ExtensionServiceName = keyof typeof EXTENSION_SERVICES;
export type ExtensionServiceMethod<S extends ExtensionServiceName> = keyof (typeof EXTENSION_SERVICES)[S] & string;
export const WASM_SERVICES: ReadonlySet<ExtensionServiceName> = new Set(['compute', 'wasm']);

/**
 * The `target` of events the host itself sends to a runtime, such as a document's units changing. No contribution id
 * can take it, so these never mix with user events on an extension's interfaces.
 */
export const HOST_EVENT_TARGET = '$host';

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
export function isHostMessage(value: unknown): value is { type: 'activate' | 'invoke' | 'cancel' | 'response' | 'deactivate' | 'event' | 'progress' | 'ping' } & Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  const int = (key: string) => Number.isSafeInteger(message[key]) && (message[key] as number) >= 0;
  switch (message.type) {
    case 'activate':
      return message.v === RUNTIME_PROTOCOL_VERSION && typeof message.extensionId === 'string' && Array.isArray(message.grants)
        && typeof message.wasm === 'boolean' && Array.isArray(message.contributions);
    case 'invoke':
      return int('invocation') && typeof message.contribution === 'string' && (message.document === undefined || typeof message.document === 'string');
    case 'cancel':
      return int('invocation');
    case 'response':
      return int('id') && (message.ok === true || (message.ok === false && typeof message.error === 'object' && message.error !== null));
    case 'deactivate':
      return typeof message.reason === 'string';
    case 'ping':
      return int('n');
    case 'progress':
      return int('id') && (message.value === null || typeof message.value === 'number');
    case 'event':
      return typeof message.target === 'string' && typeof message.component === 'string' && typeof message.event === 'string';
    default:
      return false;
  }
}

/** Bounds on any one message between host and runtime, checked before the message is otherwise looked at. */
export const MESSAGE_LIMITS = {
  /** Approximate encoded size: UTF-16 string data, binary byte lengths, 8 bytes per number, plus keys. */
  bytes: 4 * 1024 * 1024,
  /** Values (objects, arrays, strings, numbers…) in the message. */
  nodes: 200_000,
  depth: 64,
} as const;

/**
 * How fast a runtime may send messages to the host, as token buckets: each holds up to `burst` and refills at
 * `perSecond`. The host receives every message on the editor's thread, and a browser delivers a runtime's backlog
 * either without pausing for the editor's other work (Chromium) or for as long as the backlog lasts (Firefox), so a
 * runtime that outruns these is failed and ended, which drops its backlog with it.
 *
 * The rates are far above what an extension needs: a panel updating on every frame sends about 60 messages a second,
 * and a host call is one message each way. Tripping the message burst costs the editor well under 100 ms in Chromium.
 * Bytes are measured as `measureMessage` does; the byte rate admits a full-size message (4 MiB) every 125 ms.
 */
export const MESSAGE_RATE_LIMITS = {
  /** Messages of any kind, valid or not, counted before anything else looks at them. */
  messages: { burst: 5_000, perSecond: 10_000 },
  bytes: { burst: 64 * 1024 * 1024, perSecond: 32 * 1024 * 1024 },
  /**
   * The runtime's own pacing of host calls, at half the host's message rate, so an extension calling the host in a
   * tight loop is slowed down instead of failed. Only the host's limits are enforced; this one is a courtesy.
   */
  requests: { burst: 1_000, perSecond: 5_000 },
} as const;

/** A token bucket: up to `burst` tokens, refilled continuously at `perSecond`. Times are milliseconds. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(readonly burst: number, readonly perSecond: number, now: number) {
    this.tokens = burst;
    this.last = now;
  }
  /** Takes `amount` tokens if there are that many by `now`; otherwise takes none. */
  take(amount: number, now: number): boolean {
    this.refill(now);
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }
  /** Milliseconds from `now` until `amount` tokens are there (0 when they already are). */
  wait(amount: number, now: number): number {
    this.refill(now);
    return this.tokens >= amount ? 0 : ((amount - this.tokens) * 1000) / this.perSecond;
  }
  private refill(now: number): void {
    if (now > this.last) this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) * this.perSecond) / 1000);
    this.last = Math.max(this.last, now);
  }
}

/**
 * Measures a structured-cloned value without serializing it, stopping as soon as a bound is passed. Returns the
 * approximate size in bytes, or `null` when the value exceeds `limits` or holds anything a message must not
 * (functions, symbols, a cycle deeper than the depth bound).
 */
export function measureMessage(value: unknown, limits: { bytes: number; nodes: number; depth: number } = MESSAGE_LIMITS): number | null {
  let bytes = 0;
  let nodes = 0;
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): boolean => {
    if (++nodes > limits.nodes || depth > limits.depth) return false;
    switch (typeof v) {
      case 'string': bytes += 2 * v.length; break;
      case 'number': case 'bigint': bytes += 8; break;
      case 'boolean': case 'undefined': bytes += 1; break;
      case 'object': {
        if (v === null) { bytes += 1; break; }
        if (seen.has(v)) break;
        seen.add(v);
        if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) { bytes += v.byteLength; break; }
        if (v instanceof Map) {
          for (const [key, item] of v) if (!walk(key, depth + 1) || !walk(item, depth + 1)) return false;
        } else if (v instanceof Set) {
          for (const item of v) if (!walk(item, depth + 1)) return false;
        } else if (Array.isArray(v)) {
          for (const item of v) if (!walk(item, depth + 1)) return false;
        } else {
          for (const key of Object.keys(v)) {
            bytes += 2 * key.length;
            if (!walk((v as Record<string, unknown>)[key], depth + 1)) return false;
          }
        }
        break;
      }
      default:
        return false;
    }
    return bytes <= limits.bytes;
  };
  return walk(value, 0) ? bytes : null;
}
