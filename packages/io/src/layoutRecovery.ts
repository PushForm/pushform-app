// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Recovery snapshots live outside .pfl and are never treated as a successful user save. */
export interface LayoutRecoveryMetadata {
  id: string;
  name: string;
  savedContent: string;
  modifiedAt: number;
}

export interface LayoutRecoveryRecord extends LayoutRecoveryMetadata { bytes: Uint8Array }

export interface LayoutRecoveryStore {
  /** Restrict reads to this ID prefix before materializing document bytes. */
  list(idPrefix?: string): Promise<LayoutRecoveryMetadata[]>;
  read(id: string): Promise<LayoutRecoveryRecord | undefined>;
  put(record: LayoutRecoveryRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

const DB_NAME = 'pushform-native-layout-recovery';
const STORE_NAME = 'documents';
const METADATA_STORE = 'metadata';
const DB_VERSION = 1;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Layout recovery request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Layout recovery write failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Layout recovery write aborted'));
  });
  void done.catch(() => undefined);
  return done;
}

async function openDb(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      request.result.createObjectStore(METADATA_STORE, { keyPath: 'id' });
    }
  };
  return requestResult(request);
}

/** IndexedDB works in the web build and the desktop webview without native plugins. */
export class IndexedDbLayoutRecoveryStore implements LayoutRecoveryStore {
  async list(idPrefix?: string): Promise<LayoutRecoveryMetadata[]> {
    const db = await openDb();
    try {
      const transaction = db.transaction(METADATA_STORE, 'readonly');
      const done = transactionDone(transaction);
      const records = await requestResult(transaction.objectStore(METADATA_STORE).getAll(prefixRange(idPrefix)) as IDBRequest<LayoutRecoveryMetadata[]>);
      await done;
      return records.sort((a, b) => b.modifiedAt - a.modifiedAt);
    } finally {
      db.close();
    }
  }

  async read(id: string): Promise<LayoutRecoveryRecord | undefined> {
    const db = await openDb();
    try {
      const transaction = db.transaction([STORE_NAME, METADATA_STORE], 'readonly');
      const done = transactionDone(transaction);
      const metadataRequest = transaction.objectStore(METADATA_STORE).get(id) as IDBRequest<LayoutRecoveryMetadata | undefined>;
      const bytesRequest = transaction.objectStore(STORE_NAME).get(id) as IDBRequest<{ id: string; bytes: Uint8Array } | undefined>;
      const [metadata, payload] = await Promise.all([requestResult(metadataRequest), requestResult(bytesRequest), done]);
      return metadata && payload ? { ...metadata, bytes: payload.bytes } : undefined;
    } finally { db.close(); }
  }

  async put(record: LayoutRecoveryRecord): Promise<void> {
    const db = await openDb();
    try {
      const transaction = db.transaction([STORE_NAME, METADATA_STORE], 'readwrite');
      const done = transactionDone(transaction);
      const { bytes, ...metadata } = record;
      try {
        transaction.objectStore(STORE_NAME).put({ id: record.id, bytes });
        transaction.objectStore(METADATA_STORE).put(metadata);
        await done;
      } catch (error) {
        try { transaction.abort(); } catch { /* Already aborted. */ }
        await done.catch(() => undefined);
        throw error;
      }
    } finally {
      db.close();
    }
  }

  async delete(id: string): Promise<void> {
    const db = await openDb();
    try {
      const transaction = db.transaction([STORE_NAME, METADATA_STORE], 'readwrite');
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.objectStore(METADATA_STORE).delete(id);
      await transactionDone(transaction);
    } finally {
      db.close();
    }
  }
}

/** String keys are lexicographic UTF-16; the successor excludes adjacent accounts. */
function prefixRange(prefix: string | undefined): IDBKeyRange | undefined {
  if (!prefix) return undefined;
  for (let i = prefix.length - 1; i >= 0; i--) {
    const code = prefix.charCodeAt(i);
    if (code < 0xffff) return IDBKeyRange.bound(prefix, prefix.slice(0, i) + String.fromCharCode(code + 1), false, true);
  }
  return IDBKeyRange.lowerBound(prefix);
}

export function defaultLayoutRecoveryStore(): LayoutRecoveryStore | null {
  return typeof indexedDB === 'undefined' ? null : new IndexedDbLayoutRecoveryStore();
}
