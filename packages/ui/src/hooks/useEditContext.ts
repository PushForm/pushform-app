// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useReducer } from 'react';
import type { EditContext } from '@pushform/model';
import { useApp } from '../AppContext';

/**
 * The open edit context (`host.context`), re-read whenever the document host emits
 * `contextChanged`. Runtime state like the selection: never mirrored into the zustand store.
 */
export function useEditContext(): EditContext {
  const app = useApp();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => app.document.events.on('contextChanged', () => bump()), [app]);
  return app.document.context;
}
