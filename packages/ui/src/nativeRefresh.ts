// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { openModelFile, openLayoutFile } from '@pushform/io';
import type { OpenedModelFile, OpenedLayoutFile } from '@pushform/io';
import { rememberLocalWorkspace, type WorkspaceStorage } from './localWorkspaces';
import { NativeRecoveryStore } from './nativeRecovery';
import type { NativeRecoveryHead } from './nativeRecovery';

export interface NativeRefreshRevision {
  key: string;
  state: object;
  metadata: string;
  encode(): Promise<Uint8Array>;
}
export interface NativeRefreshSnapshot { activeIndex: number; entries: NativeRefreshRevision[] }
/** One running snapshot plus one coalesced latest snapshot, never an unbounded queue of revisions. */
export class NativeRefreshWriter {
  private pending: NativeRefreshSnapshot | undefined;
  private running: Promise<void> = Promise.resolve();
  private busy = false;
  private versions = new Map<string, { state: object; id: string }>();
  constructor(private readonly store: NativeRecoveryStore, private readonly failed: (error: unknown) => void, private readonly saved?: (snapshot: NativeRefreshSnapshot) => void) {}
  request(snapshot: NativeRefreshSnapshot): void {
    this.pending = { activeIndex: snapshot.activeIndex, entries: snapshot.entries.map(entry => ({ ...entry })) };
    if (this.busy) return;
    this.busy = true;
    this.running = this.drain().finally(() => {
      this.busy = false;
      if (this.pending) this.request(this.pending);
    });
  }
  async settled(): Promise<void> { while (this.busy) await this.running; }
  private async drain(): Promise<void> {
    while (this.pending) {
      const snapshot = this.pending; this.pending = undefined;
      try {
        const versions = new Map<string, { state: object; id: string }>(), entries = [];
        for (const revision of snapshot.entries) {
          let version = this.versions.get(revision.key);
          if (!version || version.state !== revision.state) {
            version = { state: revision.state, id: crypto.randomUUID() };
            await this.store.stage(version.id, await revision.encode());
          }
          versions.set(revision.key, version); entries.push({ id: version.id, metadata: revision.metadata });
        }
        await this.store.publish({ version: 1, activeIndex: snapshot.activeIndex, entries });
        this.versions = versions; this.saved?.(snapshot);
      } catch (error) { this.failed(error); }
    }
  }
}
export type NativeRefreshFile = { kind: 'model'; file: OpenedModelFile } | { kind: 'layout'; file: OpenedLayoutFile };
export interface NativeRefreshSession { store: NativeRecoveryStore; head?: NativeRecoveryHead; files: Map<string, NativeRefreshFile>; remember?: ((snapshot: NativeRefreshSnapshot) => void) | undefined }
export interface NativeRefreshProgress { name: string | null; completed: number; total: number }
const SCOPE_KEY = 'pushform:native-recovery:v1:scope';
/** Called before constructing the editor. Storage is already scoped to the signed-in account. */
export async function loadNativeRefresh(storage: Pick<Storage, 'getItem' | 'setItem'>, factory: IDBFactory = indexedDB, onProgress?: (progress: NativeRefreshProgress) => Promise<void> | void, durable?: WorkspaceStorage | null): Promise<NativeRefreshSession | undefined> {
  try {
    if (durable === null) throw new Error('Persistent local workspace storage is unavailable.');
    let scope = storage.getItem(SCOPE_KEY);
    if (!scope) { scope = crypto.randomUUID(); storage.setItem(SCOPE_KEY, scope); }
    const store = new NativeRecoveryStore(factory, scope), head = await store.head(), files = new Map<string, NativeRefreshFile>();
    const entries = head?.entries ?? [];
    for (const [index, entry] of entries.entries()) {
      let metadata: { type?: unknown; name?: unknown };
      try { metadata = JSON.parse(entry.metadata) as typeof metadata; } catch { metadata = {}; }
      await onProgress?.({ name: typeof metadata.name === 'string' ? metadata.name : null, completed: index, total: entries.length });
      try {
        const bytes = await store.read(entry.id);
        if (!bytes) continue;
        if (metadata.type === 'model') files.set(entry.id, { kind: 'model', file: await openModelFile(bytes) });
        else if (metadata.type === 'layout') files.set(entry.id, { kind: 'layout', file: await openLayoutFile(bytes) });
      } catch { /* One corrupt document does not discard the other recoverable tabs. */ }
    }
    await onProgress?.({ name: null, completed: entries.length, total: entries.length });
    const remember = durable ? (snapshot: NativeRefreshSnapshot) => {
      const names = snapshot.entries.flatMap(entry => { const metadata = JSON.parse(entry.metadata) as { name?: unknown; dirty?: boolean; identity?: string; cloudDraft?: unknown }; return typeof metadata.name === 'string' && (metadata.dirty || metadata.identity || metadata.cloudDraft) ? [metadata.name] : []; });
      rememberLocalWorkspace(durable, store.scope, names);
    } : undefined;
    return { store, files, remember, ...(head ? { head } : {}) };
  } catch { return undefined; }
}
