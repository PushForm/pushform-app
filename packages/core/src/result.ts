// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export class PushFormError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PushFormError';
  }
}
