// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Account-scoped thumbnail bytes, including uploads that must survive going offline or reloading. */
export interface CachedThumbnail {
  ownerId: string;
  fileId: string;
  revisionId: string;
  jpeg: Uint8Array;
  pendingUpload: boolean;
  touched: number;
}
export interface ThumbnailCache {
  get(ownerId: string, fileId: string): Promise<CachedThumbnail | undefined>;
  put(value: CachedThumbnail): Promise<void>;
  pending(ownerId: string): Promise<CachedThumbnail[]>;
}
const cacheKey = (ownerId: string, fileId: string): string => `${ownerId}/${fileId}`;
const STORE = 'images', LIMIT = 256;
const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
});
const completed = (value: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  value.oncomplete = () => resolve(); value.onabort = value.onerror = () => reject(value.error);
});

/** IndexedDB is the durable cache. A bounded in-memory fallback keeps unavailable browser storage non-fatal. */
export class LocalThumbnailCache implements ThumbnailCache {
  private memory = new Map<string, CachedThumbnail>();
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}
  private async database(): Promise<IDBDatabase> {
    if (!this.factory) throw new Error('Local thumbnail storage is unavailable.');
    const opening = this.factory.open('pushform-thumbnails', 1);
    opening.onupgradeneeded = () => {
      const store = opening.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('owner', 'ownerId');
    };
    return request(opening);
  }
  async get(ownerId: string, fileId: string): Promise<CachedThumbnail | undefined> {
    const key = cacheKey(ownerId, fileId);
    if (this.memory.has(key)) return this.memory.get(key);
    let db: IDBDatabase | undefined;
    try {
      db = await this.database();
      const value = await request(db.transaction(STORE).objectStore(STORE).get(key)) as CachedThumbnail | undefined;
      return value ? { ...value, jpeg: new Uint8Array(value.jpeg) } : this.memory.get(key);
    } catch { return this.memory.get(key); }
    finally { db?.close(); }
  }
  async put(value: CachedThumbnail): Promise<void> {
    const key = cacheKey(value.ownerId, value.fileId);
    this.memory.delete(key); this.memory.set(key, value);
    for (const [oldKey, old] of this.memory) {
      if (this.memory.size <= LIMIT) break;
      if (!old.pendingUpload) this.memory.delete(oldKey);
    }
    let db: IDBDatabase | undefined;
    try {
      db = await this.database();
      const tx = db.transaction(STORE, 'readwrite'), done = completed(tx);
      void done.catch(() => {}); // Observe aborts even if an individual request fails first.
      const store = tx.objectStore(STORE);
      store.put({ ...value, key });
      const entries = await request(store.index('owner').getAll(value.ownerId)) as (CachedThumbnail & { key: string })[];
      // Keep pending uploads even when the display cache is full.
      const disposable = entries.filter(item => !item.pendingUpload).sort((a, b) => b.touched - a.touched);
      for (const old of disposable.slice(LIMIT)) store.delete(old.key);
      await done;
      this.memory.delete(key);
    } catch { /* The in-memory copy still serves this session when storage is blocked or full. */ }
    finally { db?.close(); }
  }
  async pending(ownerId: string): Promise<CachedThumbnail[]> {
    const values = new Map<string, CachedThumbnail>();
    let db: IDBDatabase | undefined;
    try {
      db = await this.database();
      const records = await request(db.transaction(STORE).objectStore(STORE).index('owner').getAll(ownerId)) as CachedThumbnail[];
      for (const value of records) if (value.pendingUpload) values.set(value.fileId, { ...value, jpeg: new Uint8Array(value.jpeg) });
    } catch { /* Fall back to this session's writes. */ }
    finally { db?.close(); }
    for (const value of this.memory.values()) if (value.ownerId === ownerId) {
      if (value.pendingUpload) values.set(value.fileId, value); else values.delete(value.fileId);
    }
    return [...values.values()];
  }
}
