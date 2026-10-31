// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import type { ExtensionPlatform, ExtensionState, InstallRequest } from '@pushform/extensions';
import { Dialog } from '../components/DialogParts';
import { readFile } from './browserExtensionIo';
import { ExtensionInstallDialog } from './ExtensionInstallDialog';
import { INTEGRITY_TEXT, PERMISSION_TEXT } from './permissionText';

/**
 * The extension manager: every installed extension with its publisher, version, integrity, permissions and
 * whether it is on or running, and the developer mode section for loading unsigned packages from a file. Opening it
 * never runs extension code. Memory and processor use are not measurable per extension in a browser, so they read
 * "unavailable", never zero.
 */

function usePlatform(platform: ExtensionPlatform): ExtensionState[] {
  const revision = useSyncExternalStore((notify) => platform.subscribe(notify), () => platform.revision);
  // The revision says when the list changed.
  return useMemo(() => platform.list(), [platform, revision]);
}

const RUN_TEXT = { stopped: 'Not running', starting: 'Starting…', running: 'Running', failed: 'Stopped after a problem' } as const;

export function ExtensionManager({ platform, developerModeAllowed, developerModeOn, onClose, available = true }: {
  readonly platform: ExtensionPlatform;
  readonly developerModeAllowed: boolean;
  readonly developerModeOn: boolean;
  readonly onClose: () => void;
  /** False where extensions cannot run, such as this browser. */
  readonly available?: boolean;
}): JSX.Element {
  const extensions = usePlatform(platform);
  const [developer, setDeveloper] = useState(developerModeOn);
  const [confirmDeveloper, setConfirmDeveloper] = useState(false);
  const [request, setRequest] = useState<InstallRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ExtensionState | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async (file: File): Promise<void> => {
    setError(null);
    try {
      setRequest(await platform.sideload(new Uint8Array(await readFile(file))));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const install = async (): Promise<void> => {
    if (!request) return;
    setBusy(true);
    try {
      await platform.install(request, request.manifest.permissions);
      setRequest(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const toggleDeveloper = async (on: boolean): Promise<void> => {
    if (on && !developer) { setConfirmDeveloper(true); return; }
    await platform.setDeveloperMode(on);
    setDeveloper(on);
  };

  if (request) return <ExtensionInstallDialog request={request} busy={busy} error={error} onInstall={() => void install()} onCancel={() => { setRequest(null); setError(null); }} />;

  return (
    <Dialog title="Extensions" onClose={onClose}>
      <div className="pf-xmanager">
        {!available ? <p className="pf-xmanager-unavailable" role="note">Extensions cannot run in this browser. Use PushForm in Chrome, Edge or the desktop app.</p> : null}
        {error ? <p className="pf-xinstall-error" role="alert">{error}</p> : null}
        {extensions.length === 0 ? <p className="pf-xmanager-empty">No extensions are installed.</p> : (
          <ul className="pf-xmanager-list" aria-label="Installed extensions">
            {extensions.map((state) => <ExtensionRow key={state.record.id} state={state} platform={platform} onRemove={() => setRemoving(state)} />)}
          </ul>
        )}
        {developerModeAllowed ? (
          <section className="pf-xmanager-developer" aria-labelledby="pf-xmanager-developer-title">
            <h3 id="pf-xmanager-developer-title" className="pf-xinstall-heading">Developer mode</h3>
            <label className="pf-xui-check">
              <input type="checkbox" checked={developer} onChange={(e) => void toggleDeveloper(e.target.checked)} />
              <span>Allow unsigned extensions on this device</span>
            </label>
            {confirmDeveloper ? (
              <div className="pf-xmanager-confirm" role="alertdialog" aria-labelledby="pf-xmanager-confirm-text">
                <p id="pf-xmanager-confirm-text">Unsigned extensions have not been reviewed by PushForm. They run with the same protections as official ones, but only load extensions you build yourself or trust. They stay on this device and are not synced to your account.</p>
                <div className="pf-form-actions">
                  <button type="button" className="pf-btn" onClick={() => { setConfirmDeveloper(false); void platform.setDeveloperMode(true).then(() => setDeveloper(true)); }}>Turn on developer mode</button>
                  <button type="button" className="pf-btn" onClick={() => setConfirmDeveloper(false)}>Cancel</button>
                </div>
              </div>
            ) : null}
            {developer ? (
              <div className="pf-form-actions">
                <button type="button" className="pf-btn" onClick={() => fileInput.current?.click()}>Load extension from file…</button>
                <input ref={fileInput} type="file" accept=".zip,application/zip" hidden aria-hidden="true"
                  onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void load(file); }} />
              </div>
            ) : null}
          </section>
        ) : null}
        {removing ? <RemoveConfirm state={removing} onCancel={() => setRemoving(null)}
          onRemove={(deleteSettings) => { setRemoving(null); void platform.uninstall(removing.record.id, { deleteSettings }); }} /> : null}
        <div className="pf-form-actions"><button type="button" className="pf-btn" onClick={onClose}>Close</button></div>
      </div>
    </Dialog>
  );
}

function ExtensionRow({ state, platform, onRemove }: { state: ExtensionState; platform: ExtensionPlatform; onRemove: () => void }): JSX.Element {
  const { record } = state;
  const [details, setDetails] = useState(false);
  const sent = [...state.bytesSent].reduce((sum, [, bytes]) => sum + bytes, 0);
  return (
    <li className="pf-xmanager-row">
      <div className="pf-xmanager-row-head">
        <div>
          <strong>{record.manifest.name}</strong> <span className="pf-xmanager-muted">{record.manifest.publisher} · {record.version}</span>
          <div className={`pf-xinstall-integrity is-${record.integrity}`}>{INTEGRITY_TEXT[record.integrity]}</div>
        </div>
        <label className="pf-xui-check">
          <input type="checkbox" checked={record.enabled} aria-label={`${record.manifest.name} turned on`}
            onChange={(e) => void platform.setEnabled(record.id, e.target.checked)} />
          <span>{record.enabled ? 'On' : 'Off'}</span>
        </label>
      </div>
      <p className="pf-xmanager-muted">{RUN_TEXT[state.run]}{state.lastActivity ? ` · last used ${state.lastActivity.toLocaleTimeString()}` : ''}</p>
      {state.run === 'failed' && state.failure ? <p className="pf-xinstall-error" role="status">{state.failure.error.message}</p> : null}
      <button type="button" className="pf-btn" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? 'Hide details' : 'Details'}</button>
      {details ? (
        <div className="pf-xmanager-details">
          <h4 className="pf-xinstall-heading">Permissions</h4>
          {record.grants.length ? <ul className="pf-xinstall-list">{record.grants.map((p) => <li key={p}>{PERMISSION_TEXT[p]}</li>)}</ul> : <p>Nothing beyond its own panels and commands.</p>}
          <dl className="pf-xinstall-facts">
            <dt>Memory</dt><dd>unavailable</dd>
            <dt>Processor</dt><dd>unavailable</dd>
            <dt>Sent this session</dt><dd>{record.manifest.destinations.length ? `${sent} bytes` : 'No internet access'}</dd>
            <dt>Installed</dt><dd>{new Date(record.installedAt).toLocaleString()}</dd>
          </dl>
          {record.source === 'developer' && state.logs.length ? (
            <details className="pf-xmanager-logs"><summary>Log ({state.logs.length})</summary>
              <pre>{state.logs.slice(-50).map((l) => `${l.at.toLocaleTimeString()} ${typeof l.entry === 'string' ? l.entry : JSON.stringify(l.entry)}`).join('\n')}</pre>
            </details>
          ) : null}
          <div className="pf-form-actions"><button type="button" className="pf-btn pf-xui-button is-danger" onClick={onRemove}>Uninstall…</button></div>
        </div>
      ) : null}
    </li>
  );
}

function RemoveConfirm({ state, onCancel, onRemove }: { state: ExtensionState; onCancel: () => void; onRemove: (deleteSettings: boolean) => void }): JSX.Element {
  const [deleteSettings, setDeleteSettings] = useState(false);
  return (
    <div className="pf-xmanager-confirm" role="alertdialog" aria-labelledby="pf-xmanager-remove-text">
      <p id="pf-xmanager-remove-text">Uninstall {state.record.manifest.name}? Your documents keep everything the extension added to them.</p>
      <label className="pf-xui-check">
        <input type="checkbox" checked={deleteSettings} onChange={(e) => setDeleteSettings(e.target.checked)} />
        <span>Also delete its settings</span>
      </label>
      <div className="pf-form-actions">
        <button type="button" className="pf-btn pf-xui-button is-danger" onClick={() => onRemove(deleteSettings)}>Uninstall</button>
        <button type="button" className="pf-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
