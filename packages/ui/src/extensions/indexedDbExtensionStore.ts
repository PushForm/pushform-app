// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ExtensionStore, InstalledExtension } from '@pushform/extensions';

/**
 * Installed extensions on this device, in IndexedDB, one database per account so that accounts sharing a browser
 * never see each other's extensions.
 */
const STORE = 'extensions';

function open(name: string, factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(db: Promise<IDBDatabase>, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db.then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}

export function indexedDbExtensionStore(ownerId: string, factory: IDBFactory = indexedDB): ExtensionStore {
  const db = open(`pushform-extensions:${ownerId}`, factory);
  return {
    list: () => run(db, 'readonly', (store) => store.getAll() as IDBRequest<InstalledExtension[]>),
    put: async (record) => { await run(db, 'readwrite', (store) => store.put(record)); },
    delete: async (id) => { await run(db, 'readwrite', (store) => store.delete(id)); },
  };
}
