// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** File System Access handles are structured-cloneable and survive a page reload in IndexedDB. */
export interface BrowserDocumentHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
  isSameEntry?(other: BrowserDocumentHandle): Promise<boolean>;
}

const DB_NAME = 'pushform-file-handles';
const STORE_NAME = 'handles';

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('File handle request failed'));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('File handle write failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('File handle write aborted'));
  });
}

async function openDb(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME))
      request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
  };
  return result(request);
}

export class BrowserFileHandleStore {
  async get(id: string): Promise<BrowserDocumentHandle | null> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const completion = done(tx);
      const record = await result(tx.objectStore(STORE_NAME).get(id) as IDBRequest<{
        id: string; handle: BrowserDocumentHandle;
      } | undefined>);
      await completion;
      return record?.handle ?? null;
    } finally {
      db.close();
    }
  }

  async put(id: string, handle: BrowserDocumentHandle): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ id, handle });
      await done(tx);
    } finally {
      db.close();
    }
  }

  async delete(id: string): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      await done(tx);
    } finally {
      db.close();
    }
  }
}

export function defaultBrowserFileHandleStore(): BrowserFileHandleStore | null {
  return typeof indexedDB === 'undefined' ? null : new BrowserFileHandleStore();
}
