// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DisplayState } from '@pushform/commands';
import { displayFromStyle } from '@pushform/commands';
import type { DocumentState, ImageStore } from '@pushform/model';
import type { Viewport } from '@pushform/render';
import { useAppStore } from '../store';
import { backgroundToRender, displayToRender, fogToRender, shadowsToRender } from './renderAdapter';

/**
 * Push the document's view state (active style → display + background, shadows, fog) into the
 * viewport. The bootstrap calls this from `syncBodies` (every document change) so the active
 * style is the single source for display settings; `view.*` commands patch the style.
 */
export function applyDocumentView(viewport: Viewport, state: DocumentState, images?: ImageStore): void {
  viewport.setDisplay(displayToRender(state));
  viewport.setSky(backgroundToRender(state));
  viewport.setShadows(shadowsToRender(state));
  viewport.setFog(fogToRender(state));
  const env = state.styles.get(state.activeStyleId)?.environment;
  viewport.setEnvironment(env ?? null, state.sceneLights ?? [], env?.skyboxImageId ? images?.objectUrl(env.skyboxImageId) : undefined);
}

/**
 * Mirror the active style's toggles into `store.display` so the Display panel (and the
 * `storeDisplayHost` the `view.*` commands write) reflect style/scene changes. No-op while equal.
 */
export function syncDisplayStoreFromStyle(state: DocumentState): void {
  const style = state.styles.get(state.activeStyleId);
  if (!style) return;
  const next = displayFromStyle(style);
  const cur = useAppStore.getState().display;
  const keys = Object.keys(next) as (keyof typeof next)[];
  if (keys.every((k) => cur[k] === next[k])) return;
  useAppStore.getState().setDisplay(next as Partial<DisplayState>);
}
