// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useMemo, useRef, useState, useSyncExternalStore, type JSX, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ExtensionPlatform, ExtensionState, InstallRequest } from '@pushform/extensions';
import type { RegistryRelease } from '@pushform/extension-protocol';
import { ExtensionDirectory } from './ExtensionDirectory';
import { useExtensionInstaller } from './useExtensionInstaller';
import { Dialog } from '../components/DialogParts';
import { Icon } from '../components/Icon';
import { readFile } from './browserExtensionIo';
import { ExtensionActivityRecord, UninstalledActivity } from './ExtensionActivityRecord';
import { ExtensionInstallDialog } from './ExtensionInstallDialog';
import { INTEGRITY_TEXT, PERMISSION_TEXT } from './permissionText';

/**
 * The extension manager: every installed extension with its publisher, version, integrity, permissions and
 * whether it is on or running, its activity record and network use, and the developer mode section for loading
 * unsigned packages from a file. Opening it never runs extension code. Memory and processor use are not measurable per
 * extension in a browser, so they read "unavailable", never zero.
 *
 * The same content shows in two places: a window, for Home, and the Extensions side panel beside an editor, opened
 * from the Extensions icon at the bottom of the activity bar. Installing from either goes through the modal install
 * dialog.
 */

function usePlatform(platform: ExtensionPlatform): ExtensionState[] {
  const revision = useSyncExternalStore((notify) => platform.subscribe(notify), () => platform.revision);
  // The revision says when the list changed.
  return useMemo(() => platform.list(), [platform, revision]);
}

const RUN_TEXT = { stopped: 'Not running', starting: 'Starting…', running: 'Running', failed: 'Stopped after a problem' } as const;

interface ManagerProps {
  readonly platform: ExtensionPlatform;
  readonly developerModeAllowed: boolean;
  readonly developerModeOn: boolean;
  readonly onClose: () => void;
  /** False where extensions cannot run, such as this browser. */
  readonly available?: boolean;
}

/** What the manager shows and does, shared by the window and the side panel. */
interface ManagerState {
  readonly extensions: readonly ExtensionState[];
  readonly developer: boolean;
  readonly confirmDeveloper: boolean;
  readonly request: InstallRequest | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly removing: ExtensionState | null;
  readonly fileInput: RefObject<HTMLInputElement | null>;
  load(file: File): void;
  prepareOfficial(release: RegistryRelease): void;
  install(): void;
  cancelInstall(): void;
  toggleDeveloper(on: boolean): void;
  confirmDeveloperOn(): void;
  cancelDeveloper(): void;
  remove(state: ExtensionState | null): void;
  uninstall(deleteSettings: boolean): void;
}

function useManager(platform: ExtensionPlatform, developerModeOn: boolean): ManagerState {
  const extensions = usePlatform(platform);
  const [developer, setDeveloper] = useState(developerModeOn);
  const [confirmDeveloper, setConfirmDeveloper] = useState(false);
  const installer = useExtensionInstaller(platform);
  const [removing, setRemoving] = useState<ExtensionState | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const toggleDeveloper = async (on: boolean): Promise<void> => {
    if (on && !developer) { setConfirmDeveloper(true); return; }
    await platform.setDeveloperMode(on);
    setDeveloper(on);
  };
  return {
    extensions, developer, confirmDeveloper, request: installer.request, busy: installer.busy, error: installer.error, removing, fileInput,
    load: (file) => void installer.prepare(async () => platform.sideload(new Uint8Array(await readFile(file)))),
    prepareOfficial: (release) => { void installer.prepare(signal => platform.prepareOfficial(release.manifest.id, release.contentHash, signal)); },
    install: installer.install,
    cancelInstall: installer.cancel,
    toggleDeveloper: (on) => void toggleDeveloper(on),
    confirmDeveloperOn: () => { setConfirmDeveloper(false); void platform.setDeveloperMode(true).then(() => setDeveloper(true)); },
    cancelDeveloper: () => setConfirmDeveloper(false),
    remove: setRemoving,
    uninstall: (deleteSettings) => { if (!removing) return; setRemoving(null); void platform.uninstall(removing.record.id, { deleteSettings }); },
  };
}

/** The extension manager as a window: on Home, where there is no dock, and wherever a host prefers it. */
export function ExtensionManager({ platform, developerModeAllowed, developerModeOn, onClose, available = true }: ManagerProps): JSX.Element {
  const manager = useManager(platform, developerModeOn);
  if (manager.request) return <InstallDialog manager={manager} />;
  return (
    <Dialog title="Extensions" onClose={onClose}>
      <div className="pf-xmanager">
        <ManagerBody platform={platform} manager={manager} developerModeAllowed={developerModeAllowed} available={available} />
        <div className="pf-form-actions"><button type="button" className="pf-btn" onClick={onClose}>Close</button></div>
      </div>
    </Dialog>
  );
}

/**
 * The Extensions side panel, docked beside the editor from the activity bar's Extensions icon, in the same frame as an
 * extension's own side panel. Its content stacks and scrolls to fit the panel's width; the install dialog opens over
 * the editor, not inside the panel.
 */
export function ExtensionManagerPanel({ platform, developerModeAllowed, developerModeOn, onClose, available = true }: ManagerProps): JSX.Element {
  const manager = useManager(platform, developerModeOn);
  return (
    <section className="pf-xpanel pf-xmanager-panel" aria-label="Extensions side panel">
      <header className="pf-xpanel-head">
        <span className="pf-xpanel-icon"><Icon name="extensions" size={16} /></span>
        <div className="pf-xpanel-title"><h2>Extensions</h2></div>
        <button type="button" className="pf-iconbtn" aria-label="Close Extensions" title="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="pf-xpanel-body">
        <div className="pf-xmanager is-panel">
          <ManagerBody platform={platform} manager={manager} developerModeAllowed={developerModeAllowed} available={available} />
        </div>
      </div>
      {manager.request ? createPortal(<InstallDialog manager={manager} />, document.querySelector('.pf-app') ?? document.body) : null}
    </section>
  );
}

function InstallDialog({ manager }: { manager: ManagerState }): JSX.Element | null {
  if (!manager.request) return null;
  return <ExtensionInstallDialog request={manager.request} busy={manager.busy} error={manager.error} onInstall={manager.install} onCancel={manager.cancelInstall} />;
}

function ManagerBody({ platform, manager, developerModeAllowed, available }: {
  platform: ExtensionPlatform; manager: ManagerState; developerModeAllowed: boolean; available: boolean;
}): JSX.Element {
  const { extensions, developer, confirmDeveloper, error, removing, fileInput } = manager;
  return <>
    {!available ? <p className="pf-xmanager-unavailable" role="note">Extensions cannot run in this browser. Use PushForm in Chrome, Edge or Firefox.</p> : null}
    {error ? <p className="pf-xinstall-error" role="alert">{error}</p> : null}
    <ExtensionDirectory platform={platform} busy={manager.busy} available={available} onPrepare={manager.prepareOfficial} />
    <section className="pf-xmanager-installed" aria-labelledby="pf-xmanager-installed-title">
      <h3 id="pf-xmanager-installed-title" className="pf-xinstall-heading">Installed</h3>
      {extensions.length === 0 ? <p className="pf-xmanager-empty">No extensions are installed.</p> : (
        <ul className="pf-xmanager-list" aria-label="Installed extensions">
          {extensions.map((state) => <ExtensionRow key={state.record.id} state={state} platform={platform} onRemove={() => manager.remove(state)} />)}
        </ul>
      )}
    </section>
    <UninstalledActivity platform={platform} />
    {developerModeAllowed ? (
      <section className="pf-xmanager-developer" aria-labelledby="pf-xmanager-developer-title">
        <h3 id="pf-xmanager-developer-title" className="pf-xinstall-heading">Developer mode</h3>
        <label className="pf-xui-check">
          <input type="checkbox" checked={developer} onChange={(e) => manager.toggleDeveloper(e.target.checked)} />
          <span>Allow unsigned extensions on this device</span>
        </label>
        {confirmDeveloper ? (
          <div className="pf-xmanager-confirm" role="alertdialog" aria-labelledby="pf-xmanager-confirm-text">
            <p id="pf-xmanager-confirm-text">Unsigned extensions have not been reviewed by PushForm. They run with the same protections as official ones, but only load extensions you build yourself or trust. They stay on this device and are not synced to your account.</p>
            <div className="pf-form-actions">
              <button type="button" className="pf-btn" onClick={manager.confirmDeveloperOn}>Turn on developer mode</button>
              <button type="button" className="pf-btn" onClick={manager.cancelDeveloper}>Cancel</button>
            </div>
          </div>
        ) : null}
        {developer ? (
          <div className="pf-form-actions">
            <button type="button" className="pf-btn" onClick={() => fileInput.current?.click()}>Load extension from file…</button>
            <input ref={fileInput} type="file" accept=".zip,application/zip" hidden aria-hidden="true"
              onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) manager.load(file); }} />
          </div>
        ) : null}
      </section>
    ) : null}
    {removing ? <RemoveConfirm state={removing} onCancel={() => manager.remove(null)} onRemove={manager.uninstall} /> : null}
  </>;
}

function ExtensionRow({ state, platform, onRemove }: { state: ExtensionState; platform: ExtensionPlatform; onRemove: () => void }): JSX.Element {
  const { record } = state;
  const revocation = record.integrity === 'official' ? platform.registry?.packageRevocation(record.id, record.contentHash, record.files) : null;
  const [details, setDetails] = useState(false);
  return (
    <li className="pf-xmanager-row">
      <div className="pf-xmanager-row-head">
        <div>
          <strong>{record.manifest.name}</strong> <span className="pf-xmanager-muted">{record.manifest.publisher} · {record.version}</span>
          <div className={`pf-xinstall-integrity is-${record.integrity}`}>{INTEGRITY_TEXT[record.integrity]}</div>
        </div>
        <label className="pf-xui-check">
          <input type="checkbox" checked={record.enabled && !revocation} disabled={!!revocation} aria-label={`${record.manifest.name} turned on`}
            onChange={(e) => void platform.setEnabled(record.id, e.target.checked)} />
          <span>{revocation ? 'Revoked' : record.enabled ? 'On' : 'Off'}</span>
        </label>
      </div>
      <p className="pf-xmanager-muted">{revocation ? 'Stopped after a security revocation' : state.failure?.kind === 'verification-failed' ? 'Not started: its installed files could not be verified' : RUN_TEXT[state.run]}{state.lastActivity ? ` · last used ${state.lastActivity.toLocaleTimeString()}` : ''}</p>
      {revocation && !state.failure ? <p className="pf-xinstall-error" role="status">{revocation}</p> : null}
      {state.run === 'failed' && state.failure ? <p className="pf-xinstall-error" role="status">{state.failure.error.message}</p> : null}
      <button type="button" className="pf-btn" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? 'Hide details' : 'Details'}</button>
      {details ? (
        <div className="pf-xmanager-details">
          <h4 className="pf-xinstall-heading">Permissions</h4>
          {record.grants.length ? <ul className="pf-xinstall-list">{record.grants.map((p) => <li key={p}>{PERMISSION_TEXT[p]}</li>)}</ul> : <p>Nothing beyond its own panels and commands.</p>}
          <dl className="pf-xinstall-facts">
            <dt>Memory</dt><dd>unavailable</dd>
            <dt>Processor</dt><dd>unavailable</dd>
            <dt>Installed</dt><dd>{new Date(record.installedAt).toLocaleString()}</dd>
          </dl>
          <ExtensionActivityRecord platform={platform} id={record.id} name={record.manifest.name} session={state.egress}
            destinations={record.manifest.destinations.map((d) => new URL(d.url).origin)} />
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
