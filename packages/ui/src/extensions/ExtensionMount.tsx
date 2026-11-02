// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useState, useSyncExternalStore, type JSX } from 'react';
import type { UnitSettings } from '@pushform/core';
import type { ContributionEntry, ExtensionPlatform } from '@pushform/extensions';
import { ExtensionTarget } from './ExtensionTarget';

/**
 * A mounted interface contribution: showing it runs the contribution on `documentId`, which starts the extension if
 * needed and mounts its interface for the target; removing it cancels that run and drops the interface. A restart
 * (a new generation) runs it again. While the extension starts or has not mounted yet, a status line shows; when it
 * failed, the failure and a Restart button. The side panel and the extension tabs both show their content this way.
 */
export function ExtensionMount({ platform, entry, units, documentId }: {
  readonly platform: ExtensionPlatform;
  readonly entry: ContributionEntry;
  readonly units: UnitSettings;
  /** The document the contribution acts on. */
  readonly documentId: string;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const revision = useSyncExternalStore((notify) => platform.subscribe(notify), () => platform.revision);
  // The revision says when the state changed.
  const state = useMemo(() => platform.state(entry.extensionId), [platform, entry.extensionId, revision]);
  // The interface host exists only while the extension runs; it changes after a restart.
  const host = state?.run === 'running' ? platform.ui(entry.extensionId) : null;

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    platform.invoke(entry.extensionId, entry.id, {}, { signal: controller.signal, userAction: true, scopes: [`panel:${entry.id}`], document: documentId })
      .catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => {
      controller.abort();
      platform.ui(entry.extensionId)?.close(entry.id);
    };
  }, [platform, entry.extensionId, entry.id, documentId, state?.generation]);

  const failure = state?.run === 'failed' ? state.failure?.error.message ?? 'The extension stopped.' : error;
  const status = state?.run === 'starting' || !host ? 'Starting…' : 'Loading…';
  if (failure) return <div className="pf-xpanel-failed">
    <p className="pf-xinstall-error" role="alert">{failure}</p>
    {state?.run === 'failed' && state.failure?.kind !== 'verification-failed' ? <button type="button" className="pf-btn" onClick={() => void platform.restart(entry.extensionId)}>Restart {entry.extensionName}</button> : null}
  </div>;
  if (!host) return <p className="pf-xpanel-status" role="status">{status}</p>;
  return <ExtensionTarget host={host} target={entry.id} units={units} empty={<p className="pf-xpanel-status" role="status">{status}</p>} />;
}
