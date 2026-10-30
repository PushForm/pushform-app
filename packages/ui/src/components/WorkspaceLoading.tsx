// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useLayoutEffect, type JSX } from 'react';
import type { NativeRefreshProgress } from '../nativeRefresh';

/** A lightweight first paint: no document engine or recovery data is needed to show it. */
export function WorkspaceLoading({ progress }: { progress: NativeRefreshProgress | null }): JSX.Element {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add('pf-document-loading');
    return () => root.classList.remove('pf-document-loading');
  }, []);
  return <main className="pf-workspace-loading" aria-label="Loading workspace" aria-busy="true">
    <section role="status" aria-live="polite">
      <div className="pf-workspace-loading-brand"><img src="/pf-logo-mark.svg" alt="" width={32} height={32} /><strong>PushForm</strong></div>
      <h1>Restoring your workspace…</h1>
      <p>{progress?.name ? `Reading ${progress.name}…` : 'Preparing your documents…'}</p>
      {progress && progress.total > 0 ? <>
        <progress aria-label="Document recovery progress" value={progress.completed} max={progress.total} />
        <p>{progress.completed} of {progress.total} documents read</p>
      </> : <progress aria-label="Workspace loading progress" />}
    </section>
  </main>;
}
