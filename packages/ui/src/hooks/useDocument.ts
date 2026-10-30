// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useReducer, useSyncExternalStore } from 'react';
import { sceneRuntimeOf } from '@pushform/commands';
import type { SceneRuntime } from '@pushform/commands';
import type { DocumentState } from '@pushform/model';
import { useApp } from '../AppContext';

/**
 * The immutable document state, re-read on every document `change` (transactions, undo/redo,
 * load). Panels that list tags, scenes, styles, shadows or fog read the model directly; nothing
 * is mirrored into the zustand store.
 */
export function useDocumentState(): DocumentState {
  const app = useApp();
  const doc = app.document.doc;
  return useSyncExternalStore(
    (onChange) => doc.events.on('change', () => onChange()),
    () => doc.state,
    () => doc.state,
  );
}

/** The scene runtime (active scene id, slideshow state), re-rendering on its `change` events. */
export function useSceneRuntime(): SceneRuntime {
  const app = useApp();
  const runtime = sceneRuntimeOf(app.commands.ctx);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => runtime.events.on('change', () => bump()), [runtime]);
  return runtime;
}
