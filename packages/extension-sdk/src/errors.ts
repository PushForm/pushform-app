// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors

/** Stable error codes of host calls. */
export type ExtensionErrorCode = 'permission.denied' | 'revision.stale' | 'limit.exceeded' | 'validation.failed' | 'cancelled'
  | 'unavailable' | 'extension.unsupported' | 'extension.failed';

export const EXTENSION_ERROR_CODES: readonly ExtensionErrorCode[] = ['permission.denied', 'revision.stale', 'limit.exceeded',
  'validation.failed', 'cancelled', 'unavailable', 'extension.unsupported', 'extension.failed'];

/** How a failed host call reports itself. */
export interface ExtensionErrorData {
  code: ExtensionErrorCode;
  message: string;
  details?: Record<string, unknown> | undefined;
}

/** Whether `error` is a failure from a host call, optionally with one of the given codes. */
export function isExtensionError(error: unknown, ...codes: ExtensionErrorCode[]): error is Error & ExtensionErrorData {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && (EXTENSION_ERROR_CODES as readonly string[]).includes(code)
    && typeof (error as { message?: unknown }).message === 'string'
    && (codes.length === 0 || codes.includes(code as ExtensionErrorCode));
}
