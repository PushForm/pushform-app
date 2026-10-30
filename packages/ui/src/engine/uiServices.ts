// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { MemoryActiveMaterialHost, MemoryDisplayHost, SERVICE_ACTIVE_MATERIAL, SERVICE_DISPLAY } from '@pushform/commands';
import type { ActiveMaterialHost, CommandRegistry, DisplayHost, DisplayState } from '@pushform/commands';
import { useAppStore } from '../store';

/** `DisplayHost` backed by the zustand store: `view.*` commands write `store.display`, the renderer reads it. */
export const storeDisplayHost: DisplayHost = {
  get: () => useAppStore.getState().display,
  set: (patch) => useAppStore.getState().setDisplay(patch),
  onChange: (fn: (state: DisplayState) => void) =>
    useAppStore.subscribe((s, prev) => {
      if (s.display !== prev.display) fn(s.display);
    }),
};

/** `ActiveMaterialHost` backed by the store: the Paint Bucket and `material.*` commands read/write `store.activeMaterialId`. */
export const storeActiveMaterialHost: ActiveMaterialHost = {
  get: () => useAppStore.getState().activeMaterialId,
  set: (id) => useAppStore.getState().setActiveMaterialId(id),
  onChange: (fn: (id: number | null) => void) =>
    useAppStore.subscribe((s, prev) => {
      if (s.activeMaterialId !== prev.activeMaterialId) fn(s.activeMaterialId);
    }),
};

const installed = new WeakSet<CommandRegistry>();

/**
 * Point the command registry's UI-facing services at the store. Idempotent; called by the shell
 * (status bar / panels) on mount, and available to the bootstrap. Any state a headless
 * `MemoryDisplayHost` collected before (e.g. a K press before mount) is carried over.
 */
export function installUiServices(commands: CommandRegistry): void {
  if (installed.has(commands)) return;
  installed.add(commands);
  const prev = commands.ctx.services.get(SERVICE_DISPLAY);
  if (prev instanceof MemoryDisplayHost) useAppStore.getState().setDisplay(prev.get());
  commands.ctx.services.set(SERVICE_DISPLAY, storeDisplayHost);
  const prevMaterial = commands.ctx.services.get(SERVICE_ACTIVE_MATERIAL);
  if (prevMaterial instanceof MemoryActiveMaterialHost) useAppStore.getState().setActiveMaterialId(prevMaterial.get());
  commands.ctx.services.set(SERVICE_ACTIVE_MATERIAL, storeActiveMaterialHost);
}
