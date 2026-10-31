// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useMemo, useSyncExternalStore, type JSX } from 'react';
import { CRASH_LIMIT, CRASH_WINDOW_MS, type ContributionEntry, type ExtensionPlatform, type ExtensionState } from '@pushform/extensions';

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
        // When the extension itself failed, its failure notice says so instead.
        if (this.platform.state(entry.extensionId)?.run === 'failed') { remove(); return; }
        const error = e instanceof Error ? e.message : String(e);
        this.set(this.runs.map((r) => (r.key === key ? { ...r, error, cancel: remove } : r)));
      });
  }

  private set(runs: readonly ExtensionRun[]): void {
    this.runs = runs;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Above the status bar: a notice for each extension that stopped after a problem, with Restart and Disable, and the
 * extension commands that are running or failed.
 */
export function ExtensionActivity({ runs, platform }: { readonly runs: ExtensionRuns; readonly platform: ExtensionPlatform }): JSX.Element | null {
  const list = useSyncExternalStore(runs.subscribe, runs.list);
  const revision = useSyncExternalStore((notify) => platform.subscribe(notify), () => platform.revision);
  // The revision says when an extension's state changed.
  const failed = useMemo(() => platform.list().filter((s) => s.run === 'failed'), [platform, revision]);
  if (!list.length && !failed.length) return null;
  return (
    <div className="pf-xactivity">
      {failed.map((state) => <FailureNotice key={state.record.id} state={state} platform={platform} />)}
      <div role="status" aria-live="polite" className="pf-xactivity-runs">
      {list.map((run) => (
        <div key={run.key} className={`pf-xactivity-item${run.error ? ' is-failed' : ''}`}>
          {run.error ? null : <span className="pf-xactivity-spinner" aria-hidden="true" />}
          <span><strong>{run.title}</strong> <span className="pf-xactivity-source">({run.extensionName})</span>
            {run.error ? `: ${run.error}` : ' is running…'}</span>
          <button type="button" className="pf-btn" onClick={run.cancel}>{run.error ? 'Dismiss' : 'Cancel'}</button>
        </div>
      ))}
      </div>
    </div>
  );
}

function FailureNotice({ state, platform }: { readonly state: ExtensionState; readonly platform: ExtensionPlatform }): JSX.Element {
  const name = state.record.manifest.name;
  const id = state.record.id;
  const minutes = Math.round(CRASH_WINDOW_MS / 60_000);
  return (
    <div className="pf-xactivity-item is-failed is-notice" role="alert">
      <span>
        {state.crashDisabled
          ? <><strong>{name}</strong> stopped {CRASH_LIMIT} times in {minutes} minutes and was turned off.</>
          : <><strong>{name}</strong> stopped{state.failedAction ? <> while running <strong>{state.failedAction}</strong></> : null}.</>}
        {' '}Work it had not finished was discarded; your document keeps everything already applied.
        {state.failure ? <span className="pf-xactivity-detail">{state.failure.error.message}</span> : null}
      </span>
      <span className="pf-xactivity-actions">
        <button type="button" className="pf-btn" onClick={() => void platform.restart(id)}>{state.crashDisabled ? 'Turn on and restart' : 'Restart'}</button>
        {state.crashDisabled ? null : <button type="button" className="pf-btn" onClick={() => void platform.setEnabled(id, false)}>Disable</button>}
        <button type="button" className="pf-iconbtn pf-xactivity-dismiss" aria-label={`Dismiss the notice about ${name}`} onClick={() => platform.dismissFailure(id)}>×</button>
      </span>
    </div>
  );
}
