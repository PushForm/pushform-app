// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  EXTENSION_PERMISSIONS, ExtensionError, readPackageArchive, validatePackage, type ExtensionManifest, type ExtensionPermission,
  type ExtensionTarget,
} from '@pushform/extension-protocol';
import { ComputeHost, type ComputeWorkerHandle } from '../runtime/compute';
import { ExtensionSession, type InvokeOptions, type ServiceImplementations, type SessionFailure } from '../runtime/host';
import { FetchBroker, clipboardServices, fileServices, type ClipboardWriter, type FetchTransport, type FilePicker } from '../runtime/io';
import type { RuntimePort } from '../runtime/port';
import { ExtensionSettingsHost, type SettingsStore } from '../runtime/settings';
import { ExtensionUiHost } from '../runtime/ui';
import type { DeveloperModeSetting } from './developerMode';
import type { ExtensionStore, InstalledExtension } from './store';

/**
 * The app's extensions: what is installed on this device, what is running, and what they contribute. Listing and
 * contributions never run extension code; an extension's runtime starts on the first use of one of its
 * contributions and is shared by all of them. Every release runs in the same isolated runtime, with the same
 * permission checks and limits, whether it is official or side-loaded.
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
  /** Host services beyond those the platform provides, such as the model operations. */
  readonly hostServices?: (record: InstalledExtension) => ServiceImplementations;
  readonly filePicker?: FilePicker;
  readonly clipboard?: ClipboardWriter;
  /** Performs network requests; none on the web until a relay exists. */
  readonly fetchTransport?: FetchTransport | null;
  /** Ids that side-loaded packages may not take: built-in and official ones. `io.pushform.*` is always reserved. */
  readonly reservedIds?: (id: string) => boolean;
  /** Told when a running extension fails, after its runtime was ended. */
  readonly onFailure?: (record: InstalledExtension, failure: SessionFailure) => void;
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
}

export type RunState = 'stopped' | 'starting' | 'running' | 'failed';

export interface ExtensionState {
  readonly record: InstalledExtension;
  readonly run: RunState;
  /** Why it last failed, while `run` is 'failed'. */
  readonly failure: SessionFailure | null;
  readonly lastActivity: Date | null;
  /** Bytes sent to each destination origin during this session. */
  readonly bytesSent: ReadonlyMap<string, number>;
  /** The latest log lines it wrote. */
  readonly logs: readonly { at: Date; entry: unknown }[];
}

/** A contribution as menus, command search and the side rail list it, from the manifest alone. */
export interface ContributionEntry {
  readonly extensionId: string;
  readonly extensionName: string;
  readonly integrity: 'official' | 'unsigned';
  readonly id: string;
  readonly target: ExtensionTarget;
  readonly name: string;
}

interface Running {
  readonly record: InstalledExtension;
  readonly runtime: RuntimeHandle;
  readonly session: ExtensionSession;
  readonly ui: ExtensionUiHost;
  readonly compute: ComputeHost | null;
  readonly fetch: FetchBroker;
}

const LOG_LINES = 200;
const isReservedNamespace = (id: string): boolean => id === 'io.pushform' || id.startsWith('io.pushform.');

export class ExtensionPlatform {
  private records = new Map<string, InstalledExtension>();
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<Running>>();
  private readonly failures = new Map<string, SessionFailure>();
  private readonly activity = new Map<string, Date>();
  private readonly logs = new Map<string, { at: Date; entry: unknown }[]>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;
  private changes = 0;

  constructor(private readonly options: ExtensionPlatformOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Reads what is installed on this device. Side-loaded extensions are dropped when developer mode is not allowed. */
  async load(): Promise<void> {
    this.records = new Map((await this.options.store.list()).map((r) => [r.id, r] as const));
    if (!this.options.developerMode.allowed())
      for (const record of [...this.records.values()]) if (record.source === 'developer') await this.remove(record.id);
    this.notify();
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
    return {
      record,
      run: running ? 'running' : this.starting.has(id) ? 'starting' : this.failures.has(id) ? 'failed' : 'stopped',
      failure: this.failures.get(id) ?? null,
      lastActivity: this.activity.get(id) ?? null,
      bytesSent: new Map(running?.fetch.bytesSent ?? []),
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
    return this.request(validated.manifest, validated.integrity, validated.contentHash, record, 'developer', installed ?? null);
  }

  private request(manifest: ExtensionManifest, integrity: InstallRequest['integrity'], contentHash: string, files: Record<string, Uint8Array>,
    source: InstallRequest['source'], replaces: InstalledExtension | null): InstallRequest {
    const before = new Set(replaces?.grants ?? []);
    const destinationsBefore = new Set(replaces?.manifest.destinations.map((d) => d.url) ?? []);
    return {
      manifest, integrity, contentHash, files, source, replaces,
      newPermissions: manifest.permissions.filter((p) => !before.has(p)),
      newDestinations: manifest.destinations.map((d) => d.url).filter((url) => !destinationsBefore.has(url)),
    };
  }

  /**
   * Installs what the user approved in the install dialog, with the permissions they granted. Replacing a running
   * release stops it first; the new one starts on its next use.
   */
  async install(request: InstallRequest, grants: readonly ExtensionPermission[]): Promise<InstalledExtension> {
    const requested = new Set(request.manifest.permissions);
    const record: InstalledExtension = {
      id: request.manifest.id, version: request.manifest.version, manifest: request.manifest, files: request.files,
      contentHash: request.contentHash, integrity: request.integrity, source: request.source, enabled: request.replaces?.enabled ?? true,
      grants: EXTENSION_PERMISSIONS.filter((p) => requested.has(p) && grants.includes(p)), installedAt: this.now().toISOString(),
    };
    await this.stop(record.id);
    await this.options.store.put(record);
    this.records.set(record.id, record);
    this.failures.delete(record.id);
    this.notify();
    return record;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.enabled === enabled) return;
    if (!enabled) await this.stop(id);
    const next = { ...record, enabled };
    await this.options.store.put(next);
    this.records.set(id, next);
    this.failures.delete(id);
    this.notify();
  }

  /** Uninstalls; the extension's settings are deleted only when asked. Document content is never touched. */
  async uninstall(id: string, options: { deleteSettings: boolean }): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    if (options.deleteSettings) await this.options.settingsStore(record).remove(id);
    await this.remove(id);
  }

  private async remove(id: string): Promise<void> {
    await this.stop(id);
    await this.options.store.delete(id);
    this.records.delete(id);
    this.failures.delete(id);
    this.logs.delete(id);
    this.notify();
  }

  /** Turns developer mode on or off. Off stops and disables every side-loaded extension, keeping it installed. */
  async setDeveloperMode(enabled: boolean): Promise<void> {
    this.options.developerMode.set(enabled);
    if (!this.options.developerMode.enabled())
      for (const record of [...this.records.values()]) if (record.source === 'developer' && record.enabled) await this.setEnabled(record.id, false);
    this.notify();
  }

  /** The enabled extensions' contributions, for menus, command search and the side rail. Runs no extension code. */
  contributions(editor?: 'modeling' | 'layout'): ContributionEntry[] {
    const entries: ContributionEntry[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || (record.source === 'developer' && !this.options.developerMode.enabled())) continue;
      if (editor && !record.manifest.editors.includes(editor)) continue;
      for (const c of record.manifest.contributions)
        entries.push({ extensionId: record.id, extensionName: record.manifest.name, integrity: record.integrity, id: c.id, target: c.target, name: c.name });
    }
    return entries.sort((a, b) => a.extensionName.localeCompare(b.extensionName) || a.name.localeCompare(b.name));
  }

  /** Runs a contribution, starting the extension's runtime first if needed. */
  async invoke(extensionId: string, contributionId: string, params: unknown = {}, options: InvokeOptions = {}): Promise<unknown> {
    const running = await this.ensureRunning(extensionId);
    this.activity.set(extensionId, this.now());
    this.notify();
    return running.session.invoke(contributionId, params, options);
  }

  /** The interface host of a running extension, for rendering its panels; null when it is not running. */
  ui(extensionId: string): ExtensionUiHost | null {
    return this.running.get(extensionId)?.ui ?? null;
  }

  /** Tells running extensions that a document closed, cancelling work on it. */
  closeDocument(documentId: string): void {
    for (const running of this.running.values()) running.session.closeDocument(documentId);
  }

  /** Stops an extension's runtime, letting its `deactivate` run briefly. */
  async stop(id: string): Promise<void> {
    const running = this.running.get(id) ?? (await this.starting.get(id)?.catch(() => undefined));
    if (!running) return;
    this.running.delete(id);
    await running.session.deactivate('disable');
    running.compute?.terminateAll();
    running.ui.clear();
    running.runtime.terminate();
    this.notify();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  private ensureRunning(id: string): Promise<Running> {
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

  private async start(record: InstalledExtension): Promise<Running> {
    const runtime = await this.options.startRuntime(record);
    const grants = new Set(record.grants);
    const ref: { session?: ExtensionSession } = {};
    const ui = new ExtensionUiHost(record.manifest, (event) => ref.session?.postEvent(event));
    const settings = new ExtensionSettingsHost(record.manifest, this.options.settingsStore(record));
    const files = new Map(Object.entries(record.files));
    const compute = record.manifest.wasm.length && runtime.startCompute
      ? new ComputeHost({ manifest: record.manifest, files, spawn: () => runtime.startCompute!() }) : null;
    const fetch = new FetchBroker(record.manifest, grants, this.options.fetchTransport ?? null);
    const declining: FilePicker = { open: async () => null, save: async () => null };
    const services: ServiceImplementations = {
      ...ui.services(),
      ...settings.services(),
      ...(compute?.services() ?? {}),
      ...fileServices(record.manifest, this.options.filePicker ?? declining),
      ...(this.options.clipboard ? clipboardServices(this.options.clipboard) : {}),
      ...fetch.services(),
      'log.write': (entry) => { this.log(record.id, entry); return null; },
      ...this.options.hostServices?.(record),
    };
    const session = ref.session = new ExtensionSession({
      manifest: record.manifest, grants, port: runtime.port, services, beforeActivate: () => settings.prepare(),
      onFailure: (failure) => this.failed(record, failure),
    });
    const running: Running = { record, runtime, session, ui, compute, fetch };
    this.running.set(record.id, running);
    ui.subscribe(() => this.notify());
    return running;
  }

  private failed(record: InstalledExtension, failure: SessionFailure): void {
    const running = this.running.get(record.id);
    this.running.delete(record.id);
    if (running) {
      running.compute?.terminateAll();
      running.ui.clear();
      running.runtime.terminate();
    }
    this.failures.set(record.id, failure);
    this.notify();
    this.options.onFailure?.(record, failure);
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
