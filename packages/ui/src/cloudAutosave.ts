// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { CloudFilesError, type CloudFilesApi, type CloudSavedFile } from '@pushform/cloud';
import type { DocumentSession, DocumentTab } from './session';
import { cloudLocation, findOrCreateDocumentsProject, saveCloudDocument } from './cloudDocuments';

export type SaveStatus = 'saved' | 'waiting' | 'saving' | 'offline' | 'error' | 'conflict';
export interface AutosaveState {
  status: SaveStatus; error?: string | undefined;
  /** Why the last save failed, when the cloud client said: `trashed` means the file is in the Trash. */
  code?: CloudFilesError['code'] | undefined;
}
interface Entry extends AutosaveState {
  savedName: string; version: number; initial: boolean; paused: boolean; blocked: boolean;
  project?: string | undefined; folder?: string | null | undefined; timer?: ReturnType<typeof setTimeout> | undefined;
  running?: Promise<void> | undefined; failures: number;
  pausedIdentity?: string | undefined;
}
const version = (tab: DocumentTab): number => tab.type === 'model' ? tab.app.document.doc.version : tab.doc.version;

/** One write at a time per tab. Cloud identity advances only through a successful save. */
export class CloudAutosave {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private disposed = false;
  private enabled = true;
  private online = true;
  private personalProject: Promise<string> | undefined;
  private readonly accountId: string | null;
  private currentOwner = (): string | null => this.owner() === this.accountId ? this.accountId : null;
  private off: () => void;
  constructor(private api: CloudFilesApi, private session: DocumentSession, private owner: () => string | null,
    private onSaved: (saved: CloudSavedFile, tab: DocumentTab) => void = () => {}, private delay = 1200) {
    this.accountId = owner();
    for (const tab of session.tabs) this.entries.set(tab.id, this.entry(tab, !!tab.cloudDraft));
    this.off = session.subscribe(() => this.scan());
    this.scan();
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): number => this.revision;
  state(tab: DocumentTab): AutosaveState { return this.entries.get(tab.id) ?? { status: 'saved' }; }
  private entry(tab: DocumentTab, initial: boolean): Entry {
    return { status: 'saved', savedName: tab.name, version: version(tab), initial, project: tab.cloudDraft?.projectId, folder: tab.cloudDraft?.folderId, paused: false, blocked: false, failures: 0 };
  }
  private emit(): void { this.revision++; this.listeners.forEach(listener => listener()); }
  private needed(tab: DocumentTab, entry: Entry): boolean {
    // A placeholder only shows a model being opened; it saves once it becomes a document.
    if (tab.placeholder) return false;
    return entry.savedName !== tab.name || this.session.isDirty(tab) || (entry.initial && !cloudLocation(tab.identity));
  }
  private scan(): void {
    if (this.disposed) return;
    for (const [id, entry] of this.entries) if (!this.session.tabs.some(tab => tab.id === id)) {
      clearTimeout(entry.timer); this.entries.delete(id);
    }
    for (const tab of this.session.tabs) {
      let entry = this.entries.get(tab.id);
      const fresh = !entry;
      if (!entry) { entry = this.entry(tab, !cloudLocation(tab.identity)); this.entries.set(tab.id, entry); }
      if (tab.placeholder) continue;
      if (fresh && entry.initial && !tab.cloudDraft) this.session.setCloudDraft(tab.id);
      // An edited document that was never saved (the startup document) has a first save pending too. Its draft,
      // with the key that keeps a retried first save on one document, reaches the refresh snapshot before the
      // debounced save starts.
      else if (!tab.cloudDraft?.key && !cloudLocation(tab.identity) && this.session.isDirty(tab))
        this.session.setCloudDraft(tab.id, entry.project, entry.folder);
      const changed = entry.version !== version(tab); entry.version = version(tab);
      if (!this.needed(tab, entry) && !entry.running && !entry.blocked) {
        clearTimeout(entry.timer); entry.timer = undefined;
        if (entry.status !== 'saved') { entry.status = 'saved'; entry.error = undefined; this.emit(); }
      }
      if (this.needed(tab, entry) && !entry.running && !entry.blocked &&
        (fresh || changed || entry.status === 'saved')) this.schedule(tab, entry);
    }
  }
  private schedule(tab: DocumentTab, entry: Entry, delay = this.delay): void {
    clearTimeout(entry.timer); entry.timer = undefined;
    if (entry.blocked || entry.paused || this.disposed) return;
    entry.status = this.online ? 'waiting' : 'offline'; this.emit();
    if (!this.enabled || !this.online || !this.currentOwner()) return;
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.run(tab, entry).catch(() => {}); }, delay);
  }
  private async defaultProject(): Promise<string> {
    if (!this.personalProject) {
      const checkOwner = (): void => { if (!this.currentOwner() || this.disposed || !this.enabled) throw new CloudFilesError('auth', 'Sign in again to save your changes.'); };
      this.personalProject = findOrCreateDocumentsProject(this.api, checkOwner).catch(error => { this.personalProject = undefined; throw error; });
    }
    return this.personalProject;
  }
  /** Assign a destination synchronously before the debounced first save. */
  track(tab: DocumentTab, projectId?: string, folderId?: string | null): void {
    let entry = this.entries.get(tab.id);
    if (!entry) { entry = this.entry(tab, true); this.entries.set(tab.id, entry); }
    entry.initial = true; entry.project = projectId; entry.folder = projectId ? folderId : null;
    this.session.setCloudDraft(tab.id, projectId, folderId); this.schedule(tab, entry);
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const tab of this.session.tabs) {
      const entry = this.entries.get(tab.id)!;
      if (!enabled) { clearTimeout(entry.timer); entry.timer = undefined; }
      else if (this.needed(tab, entry) && !entry.running && !entry.blocked) this.schedule(tab, entry);
    }
  }
  setOnline(online: boolean): void {
    this.online = online;
    for (const tab of this.session.tabs) {
      const entry = this.entries.get(tab.id)!;
      if (this.needed(tab, entry) && !entry.running && !entry.blocked) this.schedule(tab, entry);
    }
  }
  pause(tab: DocumentTab, paused: boolean): void {
    const entry = this.entries.get(tab.id); if (!entry) return;
    if (paused) entry.pausedIdentity = tab.identity;
    else if (entry.pausedIdentity !== tab.identity) { entry.blocked = false; entry.error = undefined; entry.status = 'saved'; }
    entry.paused = paused; clearTimeout(entry.timer); entry.timer = undefined;
    if (!paused && this.needed(tab, entry)) this.schedule(tab, entry);
  }
  async saveNow(tab: DocumentTab): Promise<void> {
    let entry = this.entries.get(tab.id);
    if (!entry) { entry = this.entry(tab, true); this.entries.set(tab.id, entry); }
    const available = (): void => {
      if (this.disposed || !this.online || !this.enabled || !this.currentOwner() || entry.paused)
        throw new Error('Cloud saving is unavailable. Your changes are kept on this device.');
    };
    available();
    entry.blocked = false; entry.error = undefined;
    if (entry.running) await entry.running;
    // Explicit Save also establishes the first destination for an unchanged local document.
    if (!cloudLocation(tab.identity)) entry.initial = true;
    while (this.session.tabs.includes(tab) && this.needed(tab, entry)) { available(); await this.run(tab, entry); }
  }
  hasPending(): boolean {
    return this.session.tabs.some(tab => this.pending(tab));
  }
  /** Restore a tab's trashed cloud file and save to it again. */
  async restore(tab: DocumentTab): Promise<void> {
    const location = cloudLocation(tab.identity);
    if (!location || !this.api.restore) throw new Error('This document has no cloud file to restore.');
    await this.api.restore('document', location.fileId);
    await this.saveNow(tab);
  }
  /** Save every document with pending changes now, as before restarting to update; rejects if any cannot be saved. */
  async saveAll(): Promise<void> {
    await Promise.all(this.session.tabs.filter(tab => this.pending(tab)).map(tab => this.saveNow(tab)));
  }
  private pending(tab: DocumentTab): boolean {
    const entry = this.entries.get(tab.id); return !!entry && (!!entry.running || this.needed(tab, entry));
  }
  private run(tab: DocumentTab, entry: Entry): Promise<void> {
    if (entry.running) return entry.running;
    clearTimeout(entry.timer); entry.timer = undefined;
    if (this.disposed || !this.enabled || !this.online || entry.paused || !this.currentOwner() || !this.session.tabs.includes(tab)) return Promise.resolve();
    if (!this.needed(tab, entry)) { entry.status = 'saved'; this.emit(); return Promise.resolve(); }
    entry.status = 'saving'; entry.error = undefined; entry.code = undefined; this.emit();
    // Start on a microtask so reentrant session notifications see running already set. The save
    // itself serializes the snapshot here and compresses it in a worker (saveCloudDocument).
    const task = Promise.resolve().then(async () => {
      const project = cloudLocation(tab.identity)?.projectId ?? entry.project ?? await this.defaultProject();
      if (this.disposed || !this.enabled || !this.currentOwner()) return;
      if (!cloudLocation(tab.identity) && !tab.cloudDraft?.key) {
        // A first save without a key yet (an explicit Save): the key must survive a crash before the upload
        // starts. Drafts made by `track` or a scan are written with the next refresh snapshot.
        this.session.setCloudDraft(tab.id, entry.project, entry.folder); this.session.flushRefreshPersistence();
      }
      const saved = await saveCloudDocument(this.api, this.session, tab, this.currentOwner, project, tab.name, false, entry.folder ?? null);
      if (this.disposed) return;
      entry.savedName = saved.file.name;
      entry.initial = false; entry.failures = 0; entry.status = 'saved';
      this.onSaved(saved, tab);
    }).catch((error: unknown) => {
      if (this.disposed) return;
      entry.error = error instanceof Error ? error.message : 'Cloud save failed. Your changes are kept on this device.';
      entry.code = error instanceof CloudFilesError ? error.code : undefined;
      const conflict = error instanceof CloudFilesError && error.code === 'conflict';
      entry.status = conflict ? 'conflict' : this.online ? 'error' : 'offline';
      entry.blocked = !(error instanceof CloudFilesError && error.code === 'network');
      entry.failures++; throw error;
    }).finally(() => {
      entry.running = undefined;
      if (this.disposed) return;
      this.emit();
      if (this.session.tabs.includes(tab) && this.needed(tab, entry) && !entry.blocked) {
        const retry = entry.failures ? Math.min(30000, 2000 * 2 ** Math.min(entry.failures - 1, 4)) : this.delay;
        if (entry.failures) {
          if (this.enabled && this.online && !entry.paused && this.currentOwner()) entry.timer = setTimeout(() => {
            entry.timer = undefined; void this.run(tab, entry).catch(() => {});
          }, retry);
        } else this.schedule(tab, entry, retry);
      }
    });
    entry.running = task; return task;
  }
  dispose(): void {
    this.disposed = true; this.off(); this.entries.forEach(entry => clearTimeout(entry.timer)); this.listeners.clear();
  }
}
