// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useId, useState, useSyncExternalStore, type JSX } from 'react';
import type { ExtensionPermission } from '@pushform/extension-protocol';
import { CRASH_LIMIT, type ActivityEvent, type ExtensionActivity, type ExtensionPlatform, type SessionFailure, type StopReason, type Traffic } from '@pushform/extensions';
import { PERMISSION_TEXT } from './permissionText';

/**
 * An extension's activity record in the manager: what happened to it on this device, newest first, and how much it
 * sent to and received from each internet address, this session and in total. The record holds only versions,
 * permissions, reasons, addresses and counts, so that is all this shows.
 */

/** How many entries show before "Show all". */
const SHOWN = 20;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const host = (origin: string): string => {
  try { return new URL(origin).host; } catch { return origin; }
};

const permissionPhrase = (permission: ExtensionPermission): string => {
  if (permission === 'network') return 'connect to its internet addresses';
  if (permission === 'model.egress') return 'send model data to its internet addresses';
  const text = PERMISSION_TEXT[permission];
  return text.replace(/^Can /, '');
};

const STOP_TEXT: Readonly<Record<StopReason, string>> = {
  'turned-off': 'Stopped because it was turned off',
  replaced: 'Stopped for an update',
  restarted: 'Stopped to restart',
  uninstalled: 'Stopped to uninstall',
  closed: 'Stopped when PushForm closed',
  stopped: 'Stopped',
};

const FAILURE_TEXT: Readonly<Record<SessionFailure['kind'], string>> = {
  'load-failed': 'Stopped after a problem: it could not load',
  'load-timeout': 'Stopped after a problem: it took too long to load',
  'activation-failed': 'Stopped after a problem: it failed to start',
  'activation-timeout': 'Stopped after a problem: it took too long to start',
  'protocol-violation': 'Stopped after a problem: it sent messages PushForm does not accept',
  unresponsive: 'Stopped after a problem: it stopped responding',
};

/** One entry as a plain sentence. */
export function activityText(event: ActivityEvent): string {
  switch (event.type) {
    case 'installed': return `Installed version ${event.version}${event.integrity === 'unsigned' ? ' (unsigned)' : ''}`;
    case 'updated': return `Updated from version ${event.from} to ${event.to}`;
    case 'reloaded': return `Reloaded version ${event.version} from a file`;
    case 'granted': return `Allowed to ${event.permissions.map(permissionPhrase).join('; ')}`;
    case 'revoked': return `No longer allowed to ${event.permissions.map(permissionPhrase).join('; ')}`;
    case 'enabled': return 'Turned on';
    case 'disabled':
      return event.by === 'crash-loop' ? `Turned off after stopping ${CRASH_LIMIT} times`
        : event.by === 'developer-mode' ? 'Turned off with developer mode' : 'Turned off';
    case 'uninstalled':
      return event.by === 'policy' ? 'Removed because unsigned extensions are not allowed here'
        : `Uninstalled version ${event.version}, ${event.settingsDeleted ? 'deleting' : 'keeping'} its settings`;
    case 'activated': return 'Started';
    case 'stopped': return STOP_TEXT[event.reason];
    case 'failed': return FAILURE_TEXT[event.kind];
    case 'egress':
      return `Sent ${formatBytes(event.bytesSent)} to ${host(event.origin)} and received ${formatBytes(event.bytesReceived)}`
        + ` (${event.requests} ${event.requests === 1 ? 'request' : 'requests'})`;
  }
}

function useActivity(platform: ExtensionPlatform, id: string): ExtensionActivity | null {
  const revision = useSyncExternalStore((notify) => platform.subscribe(notify), () => platform.revision);
  const [activity, setActivity] = useState<ExtensionActivity | null>(null);
  useEffect(() => {
    let current = true;
    void platform.activity(id).then((a) => { if (current) setActivity(a); }, () => {});
    return () => { current = false; };
  }, [platform, id, revision]);
  return activity;
}

export function ExtensionActivityRecord({ platform, id, name, destinations, session }: {
  readonly platform: ExtensionPlatform;
  readonly id: string;
  readonly name: string;
  /** Origins the installed release declares, shown even before it used them; none for an uninstalled extension. */
  readonly destinations: readonly string[];
  /** Network use since the app started; empty for an uninstalled extension. */
  readonly session: ReadonlyMap<string, Traffic>;
}): JSX.Element {
  const activity = useActivity(platform, id);
  const [all, setAll] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const heading = useId();
  const totals = new Map((activity?.egress ?? []).map((t) => [t.origin, t] as const));
  const origins = [...new Set([...destinations, ...session.keys(), ...totals.keys()])].sort();
  const entries = activity?.entries ?? [];
  const shown = all ? entries : entries.slice(0, SHOWN);

  return (
    <>
      <h4 className="pf-xinstall-heading">Network</h4>
      {origins.length ? (
        <table className="pf-xmanager-network" aria-label={`Network use of ${name}`}>
          <thead><tr><th scope="col">Address</th><th scope="col">Sent this session</th><th scope="col">Sent in total</th><th scope="col">Received in total</th></tr></thead>
          <tbody>
            {origins.map((origin) => (
              <tr key={origin}>
                <th scope="row">{host(origin)}</th>
                <td>{formatBytes(session.get(origin)?.bytesSent ?? 0)}</td>
                <td>{formatBytes(totals.get(origin)?.bytesSent ?? 0)}</td>
                <td>{formatBytes(totals.get(origin)?.bytesReceived ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="pf-xmanager-muted">No internet access</p>}
      <h4 className="pf-xinstall-heading" id={heading}>Activity</h4>
      {activity === null ? <p className="pf-xmanager-muted">Loading…</p> : entries.length === 0 ? <p className="pf-xmanager-muted">Nothing recorded yet.</p> : (
        <ol className="pf-xmanager-activity" aria-labelledby={heading} tabIndex={0}>
          {shown.map((entry) => (
            <li key={entry.key}>
              <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time> <span>{activityText(entry.event)}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="pf-form-actions">
        {entries.length > SHOWN ? <button type="button" className="pf-btn" onClick={() => setAll(!all)}>{all ? 'Show recent' : `Show all (${entries.length})`}</button> : null}
        {entries.length || totals.size ? <button type="button" className="pf-btn" onClick={() => setConfirm(true)}>Clear activity…</button> : null}
      </div>
      {confirm ? (
        <div className="pf-xmanager-confirm" role="alertdialog" aria-labelledby={`${heading}-clear`}>
          <p id={`${heading}-clear`}>Clear the activity record of {name}, including its network totals? This cannot be undone.</p>
          <div className="pf-form-actions">
            <button type="button" className="pf-btn pf-xui-button is-danger" onClick={() => { setConfirm(false); void platform.clearActivity(id); }}>Clear activity</button>
            <button type="button" className="pf-btn" onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Extensions no longer installed whose activity record is still kept, each with its record on request. */
export function UninstalledActivity({ platform }: { readonly platform: ExtensionPlatform }): JSX.Element | null {
  const revision = useSyncExternalStore((notify) => platform.subscribe(notify), () => platform.revision);
  const [removed, setRemoved] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void platform.uninstalledActivity().then((r) => { if (current) setRemoved(r); }, () => {});
    return () => { current = false; };
  }, [platform, revision]);
  if (!removed.length) return null;
  return (
    <section className="pf-xmanager-developer" aria-labelledby="pf-xmanager-removed-title">
      <h3 id="pf-xmanager-removed-title" className="pf-xinstall-heading">Uninstalled extensions</h3>
      <p className="pf-xmanager-muted">Their activity is kept until you clear it.</p>
      <ul className="pf-xmanager-list">
        {removed.map(({ id, name }) => (
          <li key={id} className="pf-xmanager-row">
            <strong>{name}</strong>
            <button type="button" className="pf-btn" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
              {open === id ? 'Hide activity' : 'Activity'}
            </button>
            {open === id ? <div className="pf-xmanager-details"><ExtensionActivityRecord platform={platform} id={id} name={name} destinations={[]} session={new Map()} /></div> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
