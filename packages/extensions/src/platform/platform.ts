// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  EXTENSION_PERMISSIONS, ExtensionError, ExtensionPackageError, readPackageArchive, validatePackage, type ExtensionErrorData,
  type ExtensionManifest, type ExtensionPermission, type ExtensionTarget, type ToolbarCategory, type ValidatedPackage, type ValidatePackageOptions, type InspectorDeclaration,
} from '@pushform/extension-protocol';
import { ExtensionAssetHost } from '../runtime/assets';
import { ExtensionFileTransfers } from '../runtime/fileTransfers';
import { ExtensionFragmentHost } from '../runtime/fragments';
import type { ExtensionAssetStore } from '../assetStore';
import { ComputeHost, type ComputeWorkerHandle } from '../runtime/compute';
import { ExtensionDocumentHost, type ExtensionDocuments } from '../runtime/documents';
import { ExtensionSession, type InvokeOptions, type ServiceImplementations, type SessionFailure } from '../runtime/host';
import { FetchBroker, clipboardServices, fileServices, type ClipboardWriter, type FetchTransport, type FilePicker } from '../runtime/io';
import type { RuntimePort } from '../runtime/port';
import { ExtensionSettingsHost, type SettingsStore } from '../runtime/settings';
import { ExtensionUiHost, type UiOpenRequest } from '../runtime/ui';
import { ExtensionToolHost, type ExtensionTools } from '../runtime/tools';
import { vectorExportServices, vectorPrintServices, type ViewPrinter } from '../runtime/vector';
import {
  addTraffic, memoryActivityStore, type ActivityEvent, type DisabledBy, type ExtensionActivity, type ExtensionActivityStore, type StopReason,
  type Traffic,
} from './activity';
import type { DeveloperModeSetting } from './developerMode';
import type { ExtensionStore, InstalledExtension } from './store';
import type { ExtensionRegistry } from './registry';

/**
 * The app's extensions: what is installed on this device, what is running, and what they contribute. Listing and
 * contributions never run extension code; an extension's runtime starts on the first use of one of its
 * contributions and is shared by all of them. Every release runs in the same isolated runtime, with the same
 * permission checks and limits, whether it is official or side-loaded.
 *
 * A stored release is checked again before any of its code runs: its manifest must still hash to the content hash it
 * was installed under, its files must match the manifest, and an official release must carry a valid signature. Each
 * release is checked once per session; one that fails is never started, and the user is told why.
 */

/** A runtime as the platform needs it: the protocol port, a way to end it, and compute workers when declared. */
export interface RuntimeHandle {
  readonly port: RuntimePort;
  terminate(): void;
  startCompute?(): Promise<ComputeWorkerHandle>;
}

export interface ExtensionPlatformOptions {
  readonly store: ExtensionStore;
  readonly developerMode: DeveloperModeSetting;
  /** Starts the isolated runtime for a release (in the browser, `startWebRuntime`). */
  readonly startRuntime: (record: InstalledExtension) => Promise<RuntimeHandle>;
  /** Where a release keeps its settings: the account for official ones, the device for side-loaded ones. */
  readonly settingsStore: (record: InstalledExtension) => SettingsStore;
  readonly assetStore?: (record: InstalledExtension) => ExtensionAssetStore;
  /**
   * The open documents, for the `model`, `selection` and `document` services; without them those services answer
   * `unavailable`.
   */
  readonly documents?: ExtensionDocuments;
  /** The trusted active modeling viewport; absent when tools cannot run. */
  readonly tools?: ExtensionTools;
  /** Host services beyond those the platform provides, or replacements for them. */
  readonly hostServices?: (record: InstalledExtension) => ServiceImplementations;
  readonly filePicker?: FilePicker;
  /** The host's print dialog for `ui.print`; without it printing answers `unavailable`. */
  readonly printer?: ViewPrinter;
  /** Opens a panel's tab for `ui.open`; without it the request answers `unavailable`. */
  readonly openUi?: (request: UiOpenRequest) => void;
  /** Told when an extension set or framed a document's selection, so the host can show that document. */
  readonly onSelectionShown?: (extensionId: string, documentId: string) => void;
  /** User clicked an own declared tool action; routes through the shell's ordinary command/error flow. */
  readonly onToolRequested?: (request: { extensionId: string; target: string; documentId: string }) => void;
  readonly clipboard?: ClipboardWriter;
  /** Performs network requests; none on the web until a relay exists. */
  readonly fetchTransport?: FetchTransport | null;
  /** Ids that side-loaded packages may not take: built-in and official ones. `io.pushform.*` is always reserved. */
  readonly reservedIds?: (id: string) => boolean;
  /**
   * Checks PushForm's signature over an official release's manifest when a stored release is checked. Without it no
   * release can be confirmed as official, so a stored official release is refused, as installing it would be.
   */
  readonly verifySignature?: ValidatePackageOptions['verifySignature'];
  readonly registry?: ExtensionRegistry;
  /**
   * Told when an extension fails: a running one after its runtime was ended, or a stored release that failed its
   * check and was not started.
   */
  readonly onFailure?: (record: InstalledExtension, failure: ExtensionFailure) => void;
  /** Where the activity record is kept; in memory when not given. */
  readonly activity?: ExtensionActivityStore;
  readonly now?: () => Date;
}

/** What the install dialog shows and the user approves; nothing is stored until `install`. */
export interface InstallRequest {
  readonly manifest: ExtensionManifest;
  readonly integrity: 'official' | 'unsigned';
  readonly contentHash: string;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly source: 'developer' | 'registry';
  /** The release this one replaces, when it is an update or a developer reload. */
  readonly replaces: InstalledExtension | null;
  /** Permissions and destinations this release asks for that the installed one did not. */
  readonly newPermissions: readonly ExtensionPermission[];
  readonly newDestinations: readonly string[];
  readonly blockedPermissions?: readonly { readonly permission: ExtensionPermission; readonly reason: string }[];
}

export type RunState = 'stopped' | 'starting' | 'running' | 'failed';

/** A stored release whose files no longer match what was installed, so none of its code was run. */
export interface VerificationFailure {
  readonly kind: 'verification-failed';
  readonly error: ExtensionErrorData;
}

/** Why an extension stopped, or was never started. */
export type ExtensionFailure = SessionFailure | VerificationFailure;

export interface ExtensionState {
  readonly record: InstalledExtension;
  readonly run: RunState;
  /** Why it last failed, while `run` is 'failed'. */
  readonly failure: ExtensionFailure | null;
  /** The command or panel that was running when it failed, if any. */
  readonly failedAction: string | null;
  /** It was turned off because it kept failing (`CRASH_LIMIT`); turning it on or restarting clears this. */
  readonly crashDisabled: boolean;
  /** Increases on every restart, so open panels know to run again. */
  readonly generation: number;
  readonly lastActivity: Date | null;
  /** Bytes sent to each destination origin since the app started. */
  readonly bytesSent: ReadonlyMap<string, number>;
  /** Requests and bytes sent and received per destination origin since the app started. */
  readonly egress: ReadonlyMap<string, Traffic>;
  /** The latest log lines it wrote. */
  readonly logs: readonly { at: Date; entry: unknown }[];
}

/** A contribution as menus, command search and the side rail list it, from the manifest alone. */
export interface ContributionEntry {
  readonly inspector?: InspectorDeclaration;
  readonly extensionId: string;
  readonly extensionName: string;
  readonly integrity: 'official' | 'unsigned';
  readonly id: string;
  readonly target: ExtensionTarget;
  readonly name: string;
  /** A toolbar button's group. */
  readonly category?: ToolbarCategory;
  /** A toolbar button's icon: a host icon name, or the path of a PNG in the package (see `file`). */
  readonly icon?: string;
}

/** An enabled extension as the activity bar lists it, from its manifest alone. */
export interface ExtensionEntry {
  readonly id: string;
  readonly name: string;
  readonly integrity: 'official' | 'unsigned';
  /** The manifest's icon: a host icon name, or the path of a PNG in the package (see `file`); absent for the generic icon. */
  readonly icon: string | null;
  readonly contributions: readonly ContributionEntry[];
}

interface Running {
  readonly fragments: ExtensionFragmentHost;
  readonly tools: ExtensionToolHost;
  readonly assets: ExtensionAssetHost;
  readonly fileTransfers: ExtensionFileTransfers;
  readonly record: InstalledExtension;
  readonly runtime: RuntimeHandle;
  readonly session: ExtensionSession;
  readonly ui: ExtensionUiHost;
  readonly compute: ComputeHost | null;
  readonly fetch: FetchBroker;
  readonly documents: ExtensionDocumentHost | null;
}

const LOG_LINES = 200;
/** An extension that fails this many times within `CRASH_WINDOW_MS` is turned off until the user turns it on. */
export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 10 * 60_000;
const refusal = (problem: string, message: string): ExtensionError => new ExtensionError('validation.failed', message, { problem });
const isReservedNamespace = (id: string): boolean => id === 'io.pushform' || id.startsWith('io.pushform.');

export class ExtensionPlatform {
  private records = new Map<string, InstalledExtension>();
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<Running>>();
  private readonly failures = new Map<string, ExtensionFailure>();
  /**
   * The validator's result for each stored release's files, keyed by the files themselves (which every copy of a record
   * shares), so a release is hashed once per session.
   */
  private readonly verifications = new WeakMap<object, Promise<ValidatedPackage>>();
  /** Install requests made from packages this platform validated, whose files need no second check. */
  private readonly validatedRequests = new WeakSet<InstallRequest>();
  /** Extensions whose stored release failed its check: never started, and their contributions are not listed. */
  private readonly unverified = new Set<string>();
  private readonly failedActions = new Map<string, string>();
  private readonly crashes = new Map<string, number[]>();
  private readonly crashDisabled = new Set<string>();
  private readonly generations = new Map<string, number>();
  /** Names of the contributions each extension is running, by invocation. */
  private readonly inFlight = new Map<string, Map<number, string>>();
  private readonly replacing = new Set<string>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();
  private invocations = 0;
  private readonly lastUsed = new Map<string, Date>();
  private readonly logs = new Map<string, { at: Date; entry: unknown }[]>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;
  private changes = 0;
  private readonly activityStore: ExtensionActivityStore;
  /** Activity writes, in order; reads wait for them. */
  private writes: Promise<void> = Promise.resolve();
  private seq = 0;
  /** Network use per extension and destination origin since the app started, across restarts of its runtime. */
  private readonly sessionTraffic = new Map<string, Map<string, Traffic>>();

  constructor(private readonly options: ExtensionPlatformOptions) {
    this.now = options.now ?? (() => new Date());
    this.activityStore = options.activity ?? memoryActivityStore();
    options.registry?.subscribe(() => { void this.applyRevocations().catch(() => undefined); this.notify(); });
  }

  get registry(): ExtensionRegistry | null { return this.options.registry ?? null; }

  /**
   * Reads what is installed on this device and checks each release against its manifest and content hash, so menus
   * list only verified contributions. Side-loaded extensions are dropped when developer mode is not allowed.
   */
  async load(): Promise<void> {
    await this.options.registry?.initialize();
    this.records = new Map((await this.options.store.list()).map((r) => [r.id, r] as const));
    if (!this.options.developerMode.allowed())
      for (const record of [...this.records.values()]) {
        if (record.source !== 'developer') continue;
        this.note(record.id, { type: 'uninstalled', name: record.manifest.name, version: record.version, settingsDeleted: false, by: 'policy' });
        await this.remove(record.id);
      }
    await this.applyRevocations();
    await Promise.all([...this.records.values()].map((record) => this.verified(record).catch(() => undefined)));
    this.notify();
    this.options.registry?.startChecks();
  }

  /** Increases on every change listeners are told about, so a view can tell whether to read the state again. */
  get revision(): number {
    return this.changes;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): ExtensionState[] {
    return [...this.records.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)).map((record) => this.state(record.id)!);
  }

  state(id: string): ExtensionState | null {
    const record = this.records.get(id);
    if (!record) return null;
    const running = this.running.get(id);
    const traffic = this.sessionTraffic.get(id) ?? new Map<string, Traffic>();
    return {
      record,
      run: running ? 'running' : this.starting.has(id) ? 'starting' : this.failures.has(id) ? 'failed' : 'stopped',
      failure: this.failures.get(id) ?? null,
      failedAction: this.failures.has(id) ? this.failedActions.get(id) ?? null : null,
      crashDisabled: this.crashDisabled.has(id),
      generation: this.generations.get(id) ?? 0,
      lastActivity: this.lastUsed.get(id) ?? null,
      bytesSent: new Map([...traffic].map(([origin, t]) => [origin, t.bytesSent] as const)),
      egress: new Map(traffic),
      logs: [...(this.logs.get(id) ?? [])],
    };
  }

  /**
   * Reads a side-loaded package for the install dialog. Needs developer mode. The package is validated exactly as
   * at every load; a signed package cannot be side-loaded (it must come from PushForm), and an unsigned one may not
   * take a built-in or official id.
   */
  async sideload(archive: Uint8Array): Promise<InstallRequest> {
    if (!this.options.developerMode.enabled())
      throw new ExtensionError('permission.denied', 'Turn on developer mode to load extensions from a file.');
    const files = readPackageArchive(archive);
    const validated = await validatePackage(files);
    const id = validated.manifest.id;
    if (isReservedNamespace(id) || this.options.reservedIds?.(id))
      throw new ExtensionError('validation.failed', `"${id}" belongs to PushForm or an official extension; give your extension its own id.`);
    const installed = this.records.get(id);
    if (installed && installed.source !== 'developer')
      throw new ExtensionError('validation.failed', `"${id}" is installed as an official extension; uninstall it first or use another id.`);
    const record: Record<string, Uint8Array> = {};
    for (const [path, bytes] of files) record[path] = bytes;
    const request = this.request(validated.manifest, validated.integrity, validated.contentHash, record, 'developer', installed ?? null);
    this.validatedRequests.add(request);
    return request;
  }

  /** Only authenticated directory entries can create an official install request. */
  async prepareOfficial(id: string, contentHash: string, signal?: AbortSignal): Promise<InstallRequest> {
    const registry = this.options.registry;
    if (!registry) throw new ExtensionError('unavailable', 'The official extension directory is not configured.');
    const { validated, files } = await registry.package(id, contentHash, signal);
    const previous = this.records.get(id) ?? null;
    if (previous?.source === 'developer') throw refusal('namespace.conflict', 'Uninstall the developer package before installing this official extension.');
    const request = this.request(validated.manifest, validated.integrity, validated.contentHash, Object.fromEntries(files), 'registry', previous);
    this.validatedRequests.add(request);
    return request;
  }

  private request(manifest: ExtensionManifest, integrity: InstallRequest['integrity'], contentHash: string, files: Record<string, Uint8Array>,
    source: InstallRequest['source'], replaces: InstalledExtension | null): InstallRequest {
    const before = new Set(replaces?.grants ?? []);
    const destinationsBefore = new Set(replaces?.manifest.destinations.map((d) => `${d.url}\0${d.sendsModelData}`) ?? []);
    return {
      manifest, integrity, contentHash, files, source, replaces,
      newPermissions: manifest.permissions.filter((p) => !before.has(p)),
      newDestinations: manifest.destinations.filter(d => !destinationsBefore.has(`${d.url}\0${d.sendsModelData}`)).map(d => d.url),
      ...(source === 'registry' ? { blockedPermissions: this.options.registry?.revokedPermissions(manifest.id, contentHash) ?? [] } : {}),
    };
  }

  /**
   * Installs what the user approved in the install dialog, with the permissions they granted. Replacing a running
   * release stops it first; the new one starts on its next use.
   */
  async install(request: InstallRequest, grants: readonly ExtensionPermission[]): Promise<InstalledExtension> {
    if (request.source === 'registry') {
      if (!this.options.registry || !this.validatedRequests.has(request)) throw refusal('registry.unverified', 'Prepare this release from the official extension directory first.');
      this.options.registry.assertInstallable(request.manifest.id, request.contentHash, request.files);
      this.assertPermissionsCurrent(request);
    }
    const current = this.records.get(request.manifest.id) ?? null;
    if (current?.contentHash !== request.replaces?.contentHash) throw refusal('release.stale', 'The installed extension changed. Review the current release before replacing it.');
    if (this.replacing.has(request.manifest.id)) throw new ExtensionError('unavailable', 'An extension update is already being installed.');
    this.replacing.add(request.manifest.id);
    let installed = false;
    try {
      // Confirmed updates wait for invocations pinned to the old release; new invocations wait for the update.
      await this.waitForIdle(request.manifest.id);
      const record = await this.commitInstall(request, grants); installed = true; return record;
    } finally {
      this.replacing.delete(request.manifest.id);
      // Mounted panels rerun on this generation only after the new release can accept invocations.
      if (installed && current) this.generations.set(current.id, (this.generations.get(current.id) ?? 0) + 1);
      this.notify();
    }
  }

  private async commitInstall(request: InstallRequest, grants: readonly ExtensionPermission[]): Promise<InstalledExtension> {
    if (request.source === 'registry') this.options.registry!.assertInstallable(request.manifest.id, request.contentHash, request.files);
    this.assertPermissionsCurrent(request);
    const requested = new Set(request.manifest.permissions);
    const denied = new Set(request.source === 'registry' ? this.options.registry?.revokedPermissions(request.manifest.id, request.contentHash).map(entry => entry.permission) : []);
    let record: InstalledExtension = {
      id: request.manifest.id, version: request.manifest.version, manifest: request.manifest, files: request.files,
      contentHash: request.contentHash, integrity: request.integrity, source: request.source, enabled: request.replaces?.enabled ?? true,
      grants: EXTENSION_PERMISSIONS.filter((p) => requested.has(p) && grants.includes(p) && !denied.has(p)), installedAt: this.now().toISOString(),
    };
    const previous = this.records.get(record.id) ?? request.replaces;
    await this.stop(record.id, 'replaced');
    if (request.source === 'registry') this.options.registry!.assertInstallable(record.id, record.contentHash, record.files);
    this.assertPermissionsCurrent(request);
    const latestDenied = new Set(request.source === 'registry' ? this.options.registry?.revokedPermissions(record.id, record.contentHash).map(entry => entry.permission) : []);
    record = { ...record, grants: record.grants.filter(permission => !latestDenied.has(permission)) };
    await this.options.store.put(record);
    this.records.set(record.id, record);
    // Files this platform just validated are not hashed again on first use; any other request is checked then.
    if (this.validatedRequests.has(request))
      this.verifications.set(record.files, Promise.resolve({ manifest: record.manifest, integrity: record.integrity, contentHash: record.contentHash }));
    this.unverified.delete(record.id);
    this.failures.delete(record.id);
    const name = record.manifest.name;
    if (!previous) this.note(record.id, { type: 'installed', name, version: record.version, integrity: record.integrity });
    else if (previous.version === record.version) this.note(record.id, { type: 'reloaded', name, version: record.version });
    else this.note(record.id, { type: 'updated', name, from: previous.version, to: record.version });
    const before = new Set(previous?.grants ?? []);
    const granted = record.grants.filter((p) => !before.has(p));
    const revoked = [...before].filter((p) => !record.grants.includes(p));
    if (granted.length) this.note(record.id, { type: 'granted', permissions: granted });
    if (revoked.length) this.note(record.id, { type: 'revoked', permissions: revoked });
    // A feed can change while the durable write settles. Apply it before making this install available.
    await this.applyRevocations();
    return this.records.get(record.id)!;
  }

  private waitForIdle(id: string): Promise<void> {
    if (!this.inFlight.get(id)?.size) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.idleWaiters.get(id) ?? new Set(); waiters.add(resolve); this.idleWaiters.set(id, waiters);
    });
  }

  private assertPermissionsCurrent(request: InstallRequest): void {
    if (request.source !== 'registry') return;
    const current = this.options.registry?.revokedPermissions(request.manifest.id, request.contentHash) ?? [];
    if (JSON.stringify(current) !== JSON.stringify(request.blockedPermissions ?? []))
      throw refusal('permissions.stale', 'Permission revocations changed. Cancel and review this extension package again.');
  }

  private assertNotRevoked(record: InstalledExtension): void {
    if (record.integrity !== 'official') return;
    const reason = this.options.registry?.packageRevocation(record.id, record.contentHash, record.files);
    if (reason) throw refusal('release.revoked', `This release was revoked: ${reason}`);
  }

  /** Stops capabilities synchronously before awaiting persistence or graceful shutdown. */
  private async applyRevocations(): Promise<void> {
    const registry = this.options.registry; if (!registry) return;
    const pending: Promise<unknown>[] = [];
    for (const record of this.records.values()) {
      if (record.integrity !== 'official') continue;
      const reason = registry.packageRevocation(record.id, record.contentHash, record.files);
      if (reason) {
        if (!this.unverified.has(record.id)) this.note(record.id, { type: 'release-revoked', reason });
        this.refuse(record, refusal('release.revoked', `This release was revoked: ${reason}`));
        pending.push(this.stop(record.id, 'revoked'));
      } else {
        const denied = new Set(registry.revokedPermissions(record.id, record.contentHash).map(entry => entry.permission));
        const removed = record.grants.filter(permission => denied.has(permission));
        if (!removed.length) continue;
        const next = { ...record, grants: record.grants.filter(permission => !denied.has(permission)) };
        this.records.set(record.id, next);
        pending.push(this.stop(record.id, 'revoked'), this.options.store.put(next));
        this.note(record.id, { type: 'revoked', permissions: removed }); this.notify();
      }
    }
    await Promise.all(pending);
  }

  /** The user turns an extension on or off. */
  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.changeEnabled(id, enabled, 'user');
  }

  private async changeEnabled(id: string, enabled: boolean, by: DisabledBy): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.enabled === enabled) return;
    if (enabled) this.assertNotRevoked(record);
    if (!enabled) await this.stop(id, 'turned-off');
    const next = { ...record, enabled };
    await this.options.store.put(next);
    this.records.set(id, next);
    if (!this.options.registry?.packageRevocation(record.id, record.contentHash, record.files)) this.clearFailure(id);
    this.note(id, enabled ? { type: 'enabled' } : { type: 'disabled', by });
    this.notify();
  }

  /**
   * After a failure: forgets it and its crash history, turns the extension back on if it was turned off for failing,
   * and lets open panels run again. The runtime itself starts on the next use.
   */
  async restart(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    await this.stop(id, 'restarted');
    if (!record.enabled) await this.setEnabled(id, true);
    this.clearFailure(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.notify();
  }

  /** The user dismissed the failure notice; the extension stays as it is. */
  dismissFailure(id: string): void {
    if (!this.failures.delete(id)) return;
    this.failedActions.delete(id);
    this.notify();
  }

  private clearFailure(id: string): void {
    this.failures.delete(id);
    this.failedActions.delete(id);
    this.crashes.delete(id);
    this.crashDisabled.delete(id);
  }

  /** Uninstalls; the extension's settings are deleted only when asked. Document content is never touched. */
  async uninstall(id: string, options: { deleteSettings: boolean }): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    await this.stop(id, 'uninstalled');
    if (options.deleteSettings) {
      await this.options.assetStore?.(record).clear(id);
      await this.options.settingsStore(record).remove(id);
    }
    this.note(id, { type: 'uninstalled', name: record.manifest.name, version: record.version, settingsDeleted: options.deleteSettings, by: 'user' });
    await this.remove(id);
  }

  private async remove(id: string): Promise<void> {
    await this.stop(id, 'uninstalled');
    await this.options.store.delete(id);
    this.records.delete(id);
    this.unverified.delete(id);
    this.clearFailure(id);
    this.logs.delete(id);
    this.notify();
  }

  /** Turns developer mode on or off. Off stops and disables every side-loaded extension, keeping it installed. */
  async setDeveloperMode(enabled: boolean): Promise<void> {
    this.options.developerMode.set(enabled);
    if (!this.options.developerMode.enabled())
      for (const record of [...this.records.values()]) if (record.source === 'developer' && record.enabled) await this.changeEnabled(record.id, false, 'developer-mode');
    this.notify();
  }

  /** The enabled extensions' contributions, for menus, command search and the toolbar. Runs no extension code. */
  contributions(editor?: 'modeling' | 'layout'): ContributionEntry[] {
    return this.extensions(editor).flatMap((extension) => extension.contributions)
      .sort((a, b) => a.extensionName.localeCompare(b.extensionName) || a.name.localeCompare(b.name));
  }

  /**
   * The enabled extensions that list `editor` (every enabled one without it), by name, each with its contributions
   * in manifest order: what the activity bar shows. Runs no extension code.
   */
  extensions(editor?: 'modeling' | 'layout'): ExtensionEntry[] {
    const entries: ExtensionEntry[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || (record.source === 'developer' && !this.options.developerMode.enabled())) continue;
      if (this.unverified.has(record.id)) continue;
      if (editor && !record.manifest.editors.includes(editor)) continue;
      const { manifest } = record;
      entries.push({
        id: record.id, name: manifest.name, integrity: record.integrity, icon: manifest.icon ?? null,
        contributions: manifest.contributions.map((c) => ({
          extensionId: record.id, extensionName: manifest.name, integrity: record.integrity, id: c.id, target: c.target, name: c.name,
          ...(c.category ? { category: c.category } : {}), ...(c.icon ? { icon: c.icon } : {}),
          ...(c.inspector ? { inspector: c.inspector } : {}),
        })),
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The bytes of a file in an installed extension's package, such as its icon; null when there is no such file. */
  file(extensionId: string, path: string): Uint8Array | null {
    return this.records.get(extensionId)?.files[path] ?? null;
  }

  /** Runs a contribution, starting the extension's runtime first if needed. */
  async invoke(extensionId: string, contributionId: string, params: unknown = {}, options: InvokeOptions = {}): Promise<unknown> {
    const running = await this.ensureRunning(extensionId);
    if (this.replacing.has(extensionId)) throw new ExtensionError('unavailable', 'The extension is being updated.');
    this.assertNotRevoked(running.record);
    options.signal?.throwIfAborted();
    let tool: ReturnType<ExtensionToolHost['begin']> | undefined;
    const contribution = running.record.manifest.contributions.find(entry => entry.id === contributionId);
    if (contribution?.target === 'model.tool') {
      if (!running.record.grants.includes('tool.interaction') || !running.record.grants.includes('model.read'))
        throw new ExtensionError('permission.denied', 'Interactive tools require tool.interaction and model.read.');
      if (!options.document) throw new ExtensionError('unavailable', 'Choose an open model before starting this tool.');
      await running.session.activate();
      options.signal?.throwIfAborted();
      if (this.running.get(extensionId) !== running || this.replacing.has(extensionId)) throw new ExtensionError('cancelled', 'The extension changed while starting its tool.');
      tool = running.tools.begin(options.document, contribution.name);
      params = { tool: tool.input, params };
      options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, tool.signal]) : tool.signal };
    }
    if (options.inspector) {
      if (!running.record.grants.includes('model.read') || !running.record.grants.includes('selection.read')) throw new ExtensionError('permission.denied', 'Inspector targets require model.read and selection.read.');
      const declaration = running.record.manifest.contributions.find(entry => entry.id === contributionId)?.inspector;
      if (!declaration || options.inspector.targets.some(target => !declaration.targets.includes(target.kind as never))) throw new ExtensionError('validation.failed', 'The inspector targets do not match its declaration.');
      if (!options.document || !options.signal) throw new ExtensionError('validation.failed', 'An inspector requires a document and a lifetime signal.');
      running.ui.bindInspector(contributionId, options.inspector, options.document);
      const binding = options.inspector.binding;
      options.signal.addEventListener('abort', () => running.ui.close(contributionId, binding), { once: true });
      params = { inspector: options.inspector };
    }
    this.lastUsed.set(extensionId, this.now());
    this.notify();
    const name = running.record.manifest.contributions.find((c) => c.id === contributionId)?.name ?? contributionId;
    const token = ++this.invocations;
    const inFlight = this.inFlight.get(extensionId) ?? new Map<number, string>();
    this.inFlight.set(extensionId, inFlight.set(token, name));
    try {
      return await running.session.invoke(contributionId, params, options);
    } catch (error) {
      tool?.end();
      throw error;
    } finally {
      inFlight.delete(token);
      if (!inFlight.size) {
        for (const resolve of this.idleWaiters.get(extensionId) ?? []) resolve();
        this.idleWaiters.delete(extensionId);
      }
    }
  }

  /** The interface host of a running extension, for rendering its panels; null when it is not running. */
  ui(extensionId: string): ExtensionUiHost | null {
    return this.running.get(extensionId)?.ui ?? null;
  }

  /** Tells running extensions that a document closed, cancelling work on it. */
  closeDocument(documentId: string): void {
    for (const running of this.running.values()) {
      running.tools.closed(documentId);
      running.session.closeDocument(documentId);
      running.ui.closeDocument(documentId);
      running.documents?.closed(documentId);
    }
  }

  /** Stops an extension's runtime, letting its `deactivate` run briefly. `reason` is what the activity record says. */
  async stop(id: string, reason: StopReason = 'stopped'): Promise<void> {
    const running = this.running.get(id) ?? (await this.starting.get(id)?.catch(() => undefined));
    if (!running) return;
    this.running.delete(id);
    running.tools.end('disabled');
    const deactivated = running.session.deactivate('disable');
    // A security revocation ends the worker immediately; its code gets no cleanup grace period.
    if (reason === 'revoked') running.runtime.terminate();
    await deactivated;
    running.fragments.dispose();
    running.assets.dispose();
    running.fileTransfers.dispose();
    running.documents?.dispose();
    running.compute?.terminateAll();
    running.ui.clear();
    if (reason !== 'revoked') running.runtime.terminate();
    this.note(id, { type: 'stopped', reason });
    this.notify();
  }

  /** Stops every runtime, as when the app closes. */
  async stopAll(): Promise<void> {
    this.options.registry?.stopChecks();
    await Promise.all([...this.running.keys()].map((id) => this.stop(id, 'closed')));
  }

  private ensureRunning(id: string): Promise<Running> {
    const installed = this.records.get(id);
    if (installed) { try { this.assertNotRevoked(installed); } catch (error) { return Promise.reject(error); } }
    if (this.replacing.has(id)) return Promise.reject(new ExtensionError('unavailable', 'The extension is being updated.'));
    const existing = this.running.get(id);
    if (existing) return Promise.resolve(existing);
    const pending = this.starting.get(id);
    if (pending) return pending;
    const record = this.records.get(id);
    if (!record) return Promise.reject(new ExtensionError('unavailable', 'The extension is not installed.'));
    if (!record.enabled || (record.source === 'developer' && !this.options.developerMode.enabled()))
      return Promise.reject(new ExtensionError('unavailable', `${record.manifest.name} is turned off.`));
    const start = this.start(record).finally(() => this.starting.delete(id));
    this.starting.set(id, start);
    this.failures.delete(id);
    this.notify();
    return start;
  }

  /**
   * Checks a stored release as installing it did, with the package validator: the manifest must hash to the content
   * hash the release was installed under, every file must be listed with a matching hash, nothing unlisted may be
   * present but the signature, and an official release's signature must verify. Resolves to the record carrying the
   * manifest read from the verified bytes; a release that fails is refused with the specific reason, and the user is
   * told. The files are hashed once per session: turning the extension off and on, or restarting it, reuses the result.
   */
  private async verified(record: InstalledExtension): Promise<InstalledExtension> {
    try {
      this.assertNotRevoked(record);
      const files = record.files as object;
      let check = this.verifications.get(files);
      if (!check) this.verifications.set(files, check = this.validateStored(record.files));
      const validated = await check;
      this.assertNotRevoked(record);
      if (validated.contentHash !== record.contentHash)
        throw refusal('content.hash', 'Its manifest.json is not the one that was installed.');
      if (validated.manifest.id !== record.id || validated.manifest.version !== record.version)
        throw refusal('release.mismatch', 'Its manifest names a different extension or version than the one that was installed.');
      if (validated.integrity !== record.integrity)
        throw refusal('signature.invalid', record.integrity === 'official'
          ? 'It was installed as official, but it has no valid PushForm signature.'
          : 'It was installed unsigned, but its files now carry a signature.');
      const verified = record.manifest === validated.manifest ? record : { ...record, manifest: validated.manifest };
      if (this.records.get(record.id) === record) this.records.set(record.id, verified);
      this.unverified.delete(record.id);
      return verified;
    } catch (error) {
      const refused = error instanceof ExtensionError ? error : refusal('files.unreadable', 'Its installed files could not be read.');
      this.refuse(record, refused);
      throw refused;
    }
  }

  private async validateStored(files: InstalledExtension['files']): Promise<ValidatedPackage> {
    try {
      return await validatePackage(new Map(Object.entries(files)), {
        ...((this.options.registry?.verifyPackageSignature ?? this.options.verifySignature) ? { verifySignature: this.options.registry?.verifyPackageSignature ?? this.options.verifySignature! } : {}),
      });
    } catch (error) {
      if (error instanceof ExtensionPackageError) throw new ExtensionError(error.code, error.message, { ...error.details });
      throw refusal('files.unreadable', 'Its installed files could not be read.');
    }
  }

  /** Marks a release that failed its check: it is not started, its contributions are hidden, and the user is told why. */
  private refuse(record: InstalledExtension, error: ExtensionError): void {
    if (this.records.get(record.id) !== record) return;
    const failure: VerificationFailure = { kind: 'verification-failed', error: error.toJSON() };
    // One activity entry per refused release, not one per attempt to use it, until it is installed again.
    if (!this.unverified.has(record.id)) this.note(record.id, { type: 'failed', kind: 'verification-failed' });
    this.unverified.add(record.id);
    this.failures.set(record.id, failure);
    this.failedActions.delete(record.id);
    this.notify();
    this.options.onFailure?.(record, failure);
  }

  private async start(stored: InstalledExtension): Promise<Running> {
    // Nothing of a release runs, not even its runtime, until its stored files pass the check.
    const record = await this.verified(stored);
    const runtime = await this.options.startRuntime(record);
    try {
      this.assertNotRevoked(record);
      const current = this.records.get(record.id);
      if (!current || current.contentHash !== record.contentHash || current.grants.some(permission => !record.grants.includes(permission))
        || record.grants.some(permission => !current.grants.includes(permission))) throw new ExtensionError('cancelled', 'The extension changed while its runtime was starting.');
    } catch (error) { runtime.terminate(); throw error; }
    const grants = new Set(record.grants);
    const ref: { session?: ExtensionSession } = {};
    const ui = new ExtensionUiHost(record.manifest, (event) => ref.session?.postEvent(event), {
      ...(this.options.openUi ? { open: this.options.openUi } : {}),
      ...(this.options.onToolRequested ? { tool: (target: string, documentId: string) => this.options.onToolRequested!({ extensionId: record.id, target, documentId }) } : {}),
    });
    const settings = new ExtensionSettingsHost(record.manifest, this.options.settingsStore(record));
    const assetStore = this.options.assetStore?.(record) ?? null;
    const assets = new ExtensionAssetHost(record.id, assetStore);
    const files = new Map(Object.entries(record.files));
    const compute = record.manifest.wasm.length && runtime.startCompute
      ? new ComputeHost({ manifest: record.manifest, files, spawn: () => runtime.startCompute!() }) : null;
    // One activity entry per destination for this run, updated as it makes requests, plus all-time totals.
    const run = crypto.randomUUID();
    const runTraffic = new Map<string, Traffic>();
    const fetch = new FetchBroker(record.manifest, grants, this.options.fetchTransport ?? null, (origin, traffic) => {
      const session = this.sessionTraffic.get(record.id) ?? new Map<string, Traffic>();
      this.sessionTraffic.set(record.id, session.set(origin, addTraffic(session.get(origin), traffic)));
      const total = addTraffic(runTraffic.get(origin), traffic);
      runTraffic.set(origin, total);
      const at = this.note(record.id, { type: 'egress', origin, ...total }, `egress:${run}:${origin}`);
      this.write(() => this.activityStore.addEgress(record.id, origin, traffic, at));
      this.notify();
    });
    const declining: FilePicker = { open: async () => null, save: async () => null };
    const fileTransfers = new ExtensionFileTransfers(record.manifest,this.options.filePicker ?? declining);
    const fragments = new ExtensionFragmentHost({ manifest: record.manifest, files: fileTransfers, packageFiles: files,
      store: assetStore, picker: this.options.filePicker ?? declining, ...(this.options.documents ? { documents: this.options.documents } : {}) });
    const documents = this.options.documents
      ? new ExtensionDocumentHost({ manifest: record.manifest, grants, documents: this.options.documents, session: () => ref.session, nativePlacements: fragments,
        inspectorBinding: (binding, documentId) => ui.inspectorBinding(binding, documentId),
        ...(this.options.onSelectionShown ? { onSelectionShown: (documentId: string) => this.options.onSelectionShown!(record.id, documentId) } : {}) }) : null;
    const documentServices = documents?.services();
    const tools = new ExtensionToolHost(this.options.tools, () => ref.session, { grants, apply: documentServices?.['model.apply'] });
    const services: ServiceImplementations = {
      ...ui.services(),
      ...settings.services(),
      ...assets.services(),
      ...(compute?.services() ?? {}),
      ...fileServices(record.manifest, this.options.filePicker ?? declining),
      ...fileTransfers.services(),
      ...fragments.services(),
      ...vectorExportServices(record.manifest, () => ui, this.options.filePicker ?? declining),
      ...vectorPrintServices(record.manifest, () => ui, this.options.printer ?? null),
      ...(this.options.clipboard ? clipboardServices(this.options.clipboard) : {}),
      ...fetch.services(),
      'log.write': (entry) => { this.log(record.id, entry); return null; },
      ...documentServices,
      ...this.options.hostServices?.(record),
      ...tools.services(),
    };
    const session = ref.session = new ExtensionSession({
      manifest: record.manifest, grants, port: runtime.port, services, beforeActivate: () => settings.prepare(),
      onFailure: (failure) => this.failed(record, failure),
      onActivated: () => this.note(record.id, { type: 'activated' }),
      ...(documents ? { onDocument: (id: string) => documents.documentChanged(id) } : {}),
    });
    const running: Running = { record, runtime, session, ui, compute, fetch, documents, assets, fileTransfers, fragments, tools };
    this.running.set(record.id, running);
    ui.subscribe(() => this.notify());
    return running;
  }

  private failed(record: InstalledExtension, failure: SessionFailure): void {
    const running = this.running.get(record.id);
    this.running.delete(record.id);
    if (running) {
      running.tools.end('runtime.failed');
      running.fragments.dispose();
      running.assets.dispose();
      running.fileTransfers.dispose();
      running.documents?.dispose();
      running.compute?.terminateAll();
      running.ui.clear();
      running.runtime.terminate();
    }
    this.failures.set(record.id, failure);
    this.note(record.id, { type: 'failed', kind: failure.kind });
    const action = [...(this.inFlight.get(record.id)?.values() ?? [])][0];
    if (action) this.failedActions.set(record.id, action); else this.failedActions.delete(record.id);
    this.inFlight.delete(record.id);
    // Repeated failures turn the extension off, so a crash loop cannot keep restarting it.
    const now = this.now().getTime();
    const recent = [...(this.crashes.get(record.id) ?? []), now].filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashes.set(record.id, recent);
    if (recent.length >= CRASH_LIMIT && record.enabled) {
      const off = { ...record, enabled: false };
      this.records.set(record.id, off);
      this.crashDisabled.add(record.id);
      void this.options.store.put(off);
      this.note(record.id, { type: 'disabled', by: 'crash-loop' });
    }
    this.notify();
    this.options.onFailure?.(record, failure);
  }

  /**
   * An extension's activity record, newest first, and its all-time network use by destination. It is kept after
   * uninstalling, until `clearActivity`.
   */
  async activity(id: string): Promise<ExtensionActivity> {
    await this.writes;
    const [entries, egress] = await Promise.all([this.activityStore.list(id), this.activityStore.egress(id)]);
    return { entries: entries.reverse(), egress };
  }

  /** Deletes an extension's activity record and its network counts. */
  async clearActivity(id: string): Promise<void> {
    this.sessionTraffic.delete(id);
    this.write(() => this.activityStore.clear(id));
    await this.writes;
  }

  /** Extensions no longer installed whose activity record is kept, with the name they last had. */
  async uninstalledActivity(): Promise<{ id: string; name: string }[]> {
    await this.writes;
    const ids = (await this.activityStore.extensions()).filter((id) => !this.records.has(id));
    const named = await Promise.all(ids.map(async (id) => {
      const entries = await this.activityStore.list(id);
      const latest = entries.reverse().find((e) => 'name' in e.event);
      return { id, name: latest && 'name' in latest.event ? latest.event.name : id };
    }));
    return named.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Adds an activity entry, or replaces the one with `key`; returns its time. Writing it never blocks the caller. */
  private note(extensionId: string, event: ActivityEvent, key: string = crypto.randomUUID()): string {
    const at = this.now().toISOString();
    const entry = { key, extensionId, at, seq: ++this.seq, event };
    this.write(() => this.activityStore.put(entry));
    return at;
  }

  private write(action: () => Promise<void>): void {
    // A failed write loses that entry only; the record never stops an extension from working.
    this.writes = this.writes.then(action).catch(() => {}).then(() => this.notify());
  }

  private log(id: string, entry: unknown): void {
    const lines = this.logs.get(id) ?? [];
    lines.push({ at: this.now(), entry });
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
    this.logs.set(id, lines);
    this.notify();
  }

  private notify(): void {
    this.changes++;
    for (const listener of this.listeners) listener();
  }
}
