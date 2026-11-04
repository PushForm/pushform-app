// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useRef, useState } from 'react';
import { accountSessionStorage } from '../accountPersistence';
import { localWorkspaces, rememberLocalWorkspace, type LocalWorkspace } from '../localWorkspaces';
import { loadNativeRefresh } from '../nativeRefresh';
import type { DocumentSession } from '../session';

export function LocalWorkspaces({ ownerId, session, onOpened }: { ownerId: string; session: DocumentSession; onOpened(): void }) {
  const [rows, setRows] = useState<LocalWorkspace[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const storage = useMemo(() => { try { return accountSessionStorage(ownerId, window.localStorage); } catch { return null; } }, [ownerId]);
  useEffect(() => {
    alive.current = true;
    const refresh = () => { try { setRows(storage ? localWorkspaces(storage).filter(row => row.scope !== session.localWorkspaceScope).sort((a,b) => b.touched - a.touched) : []); } catch { setError('The local workspace index could not be read.'); } };
    refresh(); window.addEventListener('storage', refresh); window.addEventListener('pushform:local-workspaces', refresh);
    return () => { alive.current = false; window.removeEventListener('storage', refresh); window.removeEventListener('pushform:local-workspaces', refresh); };
  }, [storage, session]);
  const recover = async (scope: string) => {
    if (busy || !storage) return; setBusy(true); setError('');
    try {
      const workspace = await loadNativeRefresh({ getItem: () => scope, setItem() {} });
      if (!workspace?.head || !workspace.files.size) throw new Error('This workspace has no readable local checkpoint.');
      if (!alive.current) return;
      session.recoverLocalWorkspace(workspace);
      await session.settledNativeRecovery();
      if (session.recoveryError || session.tabs.some(tab => session.localSaveState(tab) !== 'saved')) throw new Error('The recovered documents could not be saved locally. The earlier checkpoint has been retained.');
      if (workspace.files.size < workspace.head.entries.length) throw new Error('Readable documents were recovered, but some entries could not be read. The earlier workspace is still available.');
      rememberLocalWorkspace(storage, scope, []);
      if (alive.current) onOpened();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'The local workspace could not be recovered.'); }
    finally { if (alive.current) setBusy(false); }
  };
  if (!rows.length && !error) return null;
  return <section className="pf-local-workspaces" aria-label="Local workspaces"><h2>Saved on this device</h2><p>Recover working copies from earlier browser tabs. Their later local edits may not be in the cloud.</p>{error && <p role="alert">{error}</p>}{rows.map(row => <article key={row.scope}><div><strong>{row.names.slice(0,3).join(', ')}{row.names.length > 3 ? ` and ${row.names.length - 3} more` : ''}</strong><p>{new Date(row.touched).toLocaleString()} · {row.names.length} document{row.names.length === 1 ? '' : 's'}</p></div><button disabled={busy} onClick={() => { void recover(row.scope); }}>{busy ? 'Recovering...' : 'Recover workspace'}</button></article>)}</section>;
}
