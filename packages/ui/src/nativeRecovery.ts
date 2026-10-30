// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Binary refresh storage. A head is published only after all referenced documents are durable. */
export interface NativeRecoveryEntry {
  id: string;
  /** Small tab metadata only; document geometry and assets belong in bytes. */
  metadata: string;
}
export interface NativeRecoveryHead {
  version: 1;
  activeIndex: number;
  entries: NativeRecoveryEntry[];
}
interface StoredHead extends NativeRecoveryHead { scope: string; touched: number }
interface StoredDocument { scope: string; id: string; bytes: Uint8Array; touched: number }
const DATABASE = 'pushform-native-recovery', DOCUMENTS = 'documents', HEADS = 'heads';
const MAX_METADATA_BYTES = 1024 * 1024;
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Native recovery request failed'));
  });
}
function completed(tx: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Native recovery transaction aborted'));
  });
  // Request failures can arrive before the caller reaches its await of this promise.
  void done.catch(() => {});
  return done;
}
function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DATABASE, 1); let failed = false;
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DOCUMENTS, { keyPath: ['scope', 'id'] }).createIndex('scope', 'scope');
      req.result.createObjectStore(HEADS, { keyPath: 'scope' });
    };
    req.onerror = () => reject(req.error ?? new Error('Cannot open native recovery storage'));
    req.onblocked = () => { failed = true; reject(new Error('Native recovery database upgrade blocked')); };
    req.onsuccess = () => { if (failed) req.result.close(); else resolve(req.result); };
  });
}
function validate(head: NativeRecoveryHead): void {
  if (head.version !== 1 || !Array.isArray(head.entries) || head.entries.length > 1000 ||
    !Number.isInteger(head.activeIndex) || (head.entries.length ? head.activeIndex < 0 || head.activeIndex >= head.entries.length : head.activeIndex !== -1))
    throw new Error('Invalid native recovery head');
  const ids = new Set<string>(); let size = 0;
  for (const entry of head.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 256 || ids.has(entry.id) || typeof entry.metadata !== 'string') throw new Error('Invalid native recovery entry');
    ids.add(entry.id); size += new TextEncoder().encode(entry.metadata).byteLength;
    if (size > MAX_METADATA_BYTES) throw new Error('Native recovery metadata exceeds limit');
  }
}

/** Each scope is a random browser-tab token kept in the account-scoped session storage.
 * IDs name immutable versions, never mutable document slots. Callers serialize writes per scope.
 * No method loads all document bytes together. Quota failures leave the previous head readable. */
export class NativeRecoveryStore {
  constructor(private readonly factory: IDBFactory, readonly scope: string, private readonly now: () => number = Date.now) {
    if (!scope || scope.length > 256) throw new Error('Invalid native recovery scope');
  }
  async stage(id: string, bytes: Uint8Array): Promise<void> {
    validate({ version: 1, activeIndex: 0, entries: [{ id, metadata: '' }] });
    const db = await open(this.factory);
    try {
      const tx = db.transaction(DOCUMENTS, 'readwrite'), done = completed(tx);
      // add, not put: a failed or concurrent write cannot replace a published revision.
      tx.objectStore(DOCUMENTS).add({ scope: this.scope, id, bytes, touched: this.now() } satisfies StoredDocument);
      await done;
    } finally { db.close(); }
  }
  async read(id: string): Promise<Uint8Array | undefined> {
    const db = await open(this.factory);
    try {
      const tx = db.transaction(DOCUMENTS, 'readonly'), done = completed(tx);
      const value = await request(tx.objectStore(DOCUMENTS).get([this.scope, id]) as IDBRequest<StoredDocument | undefined>);
      await done;
      return value ? new Uint8Array(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength) : undefined;
    } finally { db.close(); }
  }
  async head(): Promise<NativeRecoveryHead | undefined> {
    const db = await open(this.factory);
    try {
      const tx = db.transaction(HEADS, 'readonly'), done = completed(tx);
      const value = await request(tx.objectStore(HEADS).get(this.scope) as IDBRequest<StoredHead | undefined>);
      await done;
      if (!value) return undefined;
      validate(value);
      return { version: 1, activeIndex: value.activeIndex, entries: value.entries };
    } finally { db.close(); }
  }
  /** Atomically commit the head and remove obsolete versions within this scope only. */
  async publish(head: NativeRecoveryHead): Promise<void> {
    validate(head);
    // Capture metadata before the first await, so a caller cannot change the published revision.
    const captured: StoredHead = { version: 1, scope: this.scope, touched: this.now(), activeIndex: head.activeIndex, entries: head.entries.map(e => ({ ...e })) };
    const db = await open(this.factory);
    try {
      const tx = db.transaction([DOCUMENTS, HEADS], 'readwrite'), done = completed(tx), documents = tx.objectStore(DOCUMENTS);
      try {
        const keys = await request(documents.index('scope').getAllKeys(this.scope));
        const available = new Set(keys.map(key => (key as string[])[1]!));
        if (captured.entries.some(entry => !available.has(entry.id))) throw new Error('Native recovery document is not durable');
        tx.objectStore(HEADS).put(captured);
        const keep = new Set(captured.entries.map(entry => entry.id));
        for (const key of keys) if (!keep.has((key as string[])[1]!)) documents.delete(key);
        await done;
      } catch (error) {
        try { tx.abort(); } catch { /* Already finished/aborted. */ }
        await done.catch(() => {}); throw error;
      }
    } finally { db.close(); }
  }
}
