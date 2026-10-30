// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useLayoutEffect, useSyncExternalStore, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { DocumentLoading as Loading } from '../documentLoading';

export function DocumentLoading({ loading }: { loading: Loading }): JSX.Element | null {
  const current = useSyncExternalStore(loading.subscribe, loading.getSnapshot);
  const busy = current !== null;
  useLayoutEffect(() => {
    if (!busy) return;
    const root = document.documentElement;
    const previous = root.classList.contains('pf-document-loading');
    root.classList.add('pf-document-loading');
    return () => { if (!previous) root.classList.remove('pf-document-loading'); };
  }, [busy]);
  return current ? createPortal(<div className="pf-document-load" role="status" aria-live="polite">
    <strong>Opening {current.name}</strong>
    <span>{current.stage}</span>
    <progress aria-label="File loading progress" />
  </div>, document.body) : null;
}
