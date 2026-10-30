// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect } from 'react';
import type { EntityRef } from '@pushform/model';
import { useApp } from '../AppContext';
import { useAppStore } from '../store';

/**
 * Current selection refs, re-read whenever the Selection or the Document emits `change`. Only a
 * counter lives in the zustand store; the refs themselves stay in the model's Selection.
 */
export function useSelectionRefs(): EntityRef[] {
  const app = useApp();
  useAppStore((s) => s.selectionVersion);
  useEffect(() => {
    const bump = () => useAppStore.getState().bumpSelectionVersion();
    const offSel = app.document.selection.events.on('change', bump);
    const offDoc = app.document.doc.events.on('change', bump);
    bump();
    return () => {
      offSel();
      offDoc();
    };
  }, [app]);
  return app.document.selection.refs;
}
