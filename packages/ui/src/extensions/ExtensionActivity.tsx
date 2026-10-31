// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useSyncExternalStore, type JSX } from 'react';
import type { ContributionEntry, ExtensionPlatform } from '@pushform/extensions';

/**
 * Extension commands the user started, while they run and after they fail. Each can be cancelled; editing goes on
 * meanwhile, because the extension runs apart from the editor.
 */
export interface ExtensionRun {
  readonly key: number;
  readonly title: string;
  readonly extensionName: string;
  readonly error: string | null;
  cancel(): void;
}

export class ExtensionRuns {
  private runs: readonly ExtensionRun[] = [];
  private next = 1;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly platform: ExtensionPlatform) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly list = (): readonly ExtensionRun[] => this.runs;

  /** Runs a command or selection action the user started, on `documentId`. */
  start(entry: ContributionEntry, documentId: string, params: unknown = {}): Promise<void> {
    const controller = new AbortController();
    const key = this.next++;
    const remove = (): void => this.set(this.runs.filter((r) => r.key !== key));
    this.set([...this.runs, { key, title: entry.name, extensionName: entry.extensionName, error: null, cancel: () => { controller.abort(); remove(); } }]);
    return this.platform.invoke(entry.extensionId, entry.id, params, { signal: controller.signal, userAction: true, document: documentId })
      .then(remove, (e: unknown) => {
        if (controller.signal.aborted) return;
        const error = e instanceof Error ? e.message : String(e);
        this.set(this.runs.map((r) => (r.key === key ? { ...r, error, cancel: remove } : r)));
      });
  }

  private set(runs: readonly ExtensionRun[]): void {
    this.runs = runs;
    for (const listener of this.listeners) listener();
  }
}

/** The running and failed extension commands, shown above the status bar. */
export function ExtensionActivity({ runs }: { readonly runs: ExtensionRuns }): JSX.Element | null {
  const list = useSyncExternalStore(runs.subscribe, runs.list);
  if (!list.length) return null;
  return (
    <div className="pf-xactivity" role="status" aria-live="polite">
      {list.map((run) => (
        <div key={run.key} className={`pf-xactivity-item${run.error ? ' is-failed' : ''}`}>
          {run.error ? null : <span className="pf-xactivity-spinner" aria-hidden="true" />}
          <span><strong>{run.title}</strong> <span className="pf-xactivity-source">({run.extensionName})</span>
            {run.error ? `: ${run.error}` : ' is running…'}</span>
          <button type="button" className="pf-btn" onClick={run.cancel}>{run.error ? 'Dismiss' : 'Cancel'}</button>
        </div>
      ))}
    </div>
  );
}
