// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { NativePhysicalPlacement } from '@pushform/commands';

/** Trusted session-owned input held until a model batch finishes or rolls back. Never exposed to guests. */
export interface NativePlacementAccess {
  withPlacements<T>(handles: readonly string[], signal: AbortSignal,
    run: (placements: ReadonlyMap<string, NativePhysicalPlacement>, active: AbortSignal) => Promise<T>): Promise<T>;
}
