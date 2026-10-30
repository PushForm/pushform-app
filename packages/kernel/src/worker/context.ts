// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ManifoldToplevel } from 'manifold-3d';
import { ManifoldCache } from './ManifoldCache';
import { loadManifold } from './ManifoldModule';

/** Everything an op needs: the wasm module and the body cache. Ops are pure functions of (ctx, req). */
export interface KernelContext {
  readonly wasm: ManifoldToplevel;
  readonly cache: ManifoldCache;
}

export async function createKernelContext(cacheCapacity?: number): Promise<KernelContext> {
  const wasm = await loadManifold();
  return { wasm, cache: new ManifoldCache(cacheCapacity) };
}

interface Deletable {
  delete(): void;
}

/** Collects wasm handles created during an op so they are freed exactly once, in `finally`. */
export class Scope {
  private readonly items: Deletable[] = [];

  /** Register a handle for deletion when the scope is disposed. */
  track<T extends Deletable>(handle: T): T {
    this.items.push(handle);
    return handle;
  }

  /** Remove a handle from the scope (the caller takes ownership). */
  release<T extends Deletable>(handle: T): T {
    const i = this.items.indexOf(handle);
    if (i >= 0) this.items.splice(i, 1);
    return handle;
  }

  dispose(): void {
    while (this.items.length > 0) this.items.pop()?.delete();
  }
}

/** Run `fn` with a scope and dispose it afterwards, even on error. */
export function withScope<T>(fn: (scope: Scope) => T): T {
  const scope = new Scope();
  try {
    return fn(scope);
  } finally {
    scope.dispose();
  }
}
