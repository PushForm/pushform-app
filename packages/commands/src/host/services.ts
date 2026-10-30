// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { PushFormError } from '@pushform/core';
import type { TagId } from '@pushform/core';
import type { KernelClient } from '@pushform/kernel';
import type { InferenceEngine } from '@pushform/inference';
import type { CommandContext } from '../registry/Command';
import { CommandRegistry, SERVICE_COMMANDS } from '../registry/CommandRegistry';
import { DocumentHost } from './DocumentHost';
import { MemoryDisplayHost, type DisplayHost } from './DisplayHost';

/** Keys in `CommandContext.services`. */
export const SERVICE_DOCUMENT = 'document';
export const SERVICE_KERNEL = 'kernel';
export const SERVICE_INFERENCE = 'inference';
/** Display/style toggles; the UI installs a host backed by its store. */
export const SERVICE_DISPLAY = 'display';
export { SERVICE_COMMANDS };

export function hostOf(ctx: CommandContext): DocumentHost {
  const h = ctx.services.get(SERVICE_DOCUMENT);
  if (!(h instanceof DocumentHost)) throw new PushFormError('service.missing', 'Document service missing');
  return h;
}
export function kernelOf(ctx: CommandContext): KernelClient {
  const k = ctx.services.get(SERVICE_KERNEL);
  if (!k) throw new PushFormError('service.missing', 'Kernel service missing');
  return k as KernelClient;
}
export function inferenceOf(ctx: CommandContext): InferenceEngine {
  const i = ctx.services.get(SERVICE_INFERENCE);
  if (!i) throw new PushFormError('service.missing', 'Inference service missing');
  return i as InferenceEngine;
}

/** The registry executing the current command (published by `CommandRegistry` on construction). */
export function registryOf(ctx: CommandContext): CommandRegistry {
  const r = ctx.services.get(SERVICE_COMMANDS);
  if (!(r instanceof CommandRegistry)) throw new PushFormError('service.missing', 'Command registry service missing');
  return r;
}
/** Display host; an in-memory one is installed lazily so `view.*` commands work headless. */
export function displayOf(ctx: CommandContext): DisplayHost {
  let d = ctx.services.get(SERVICE_DISPLAY) as DisplayHost | undefined;
  if (!d) {
    d = new MemoryDisplayHost();
    ctx.services.set(SERVICE_DISPLAY, d);
  }
  return d;
}

/**
 * The active tag (Tags panel pencil) as a `tagId` option for `SketchGraph.addEdge` /
 * `bodyFromMesh`: `{ tagId }` when one is set and still exists in the document, else `{}` so the
 * callee falls back to the document's "Untagged" tag.
 */
export function activeTagOpt(ctx: CommandContext): { tagId?: TagId } {
  const id = (ctx.services.get(SERVICE_DISPLAY) as DisplayHost | undefined)?.get().activeTagId ?? null;
  if (id === null) return {};
  const h = ctx.services.get(SERVICE_DOCUMENT);
  if (h instanceof DocumentHost && !h.doc.state.tags.has(id as TagId)) return {};
  return { tagId: id as TagId };
}

/** Active material of the Paint Bucket / Materials panel (runtime UI state; the UI backs it with its store). */
export const SERVICE_ACTIVE_MATERIAL = 'activeMaterial';

export interface ActiveMaterialHost {
  get(): number | null;
  set(id: number | null): void;
  onChange(fn: (id: number | null) => void): () => void;
}

/** In-memory active material host (headless scripts, tests, and before the UI installs its own). */
export class MemoryActiveMaterialHost implements ActiveMaterialHost {
  private id: number | null = null;
  private listeners = new Set<(id: number | null) => void>();
  get(): number | null {
    return this.id;
  }
  set(id: number | null): void {
    if (this.id === id) return;
    this.id = id;
    for (const fn of [...this.listeners]) fn(id);
  }
  onChange(fn: (id: number | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Active material host; an in-memory one is installed lazily so `paint.*` commands work headless. */
export function activeMaterialOf(ctx: CommandContext): ActiveMaterialHost {
  let h = ctx.services.get(SERVICE_ACTIVE_MATERIAL) as ActiveMaterialHost | undefined;
  if (!h) {
    h = new MemoryActiveMaterialHost();
    ctx.services.set(SERVICE_ACTIVE_MATERIAL, h);
  }
  return h;
}
