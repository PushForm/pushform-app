// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  ACTIVITY_LIMITS, activityOverflow, addTraffic, sortActivity, type ActivityEntry, type EgressTotal, type ExtensionActivityStore,
  type ExtensionStore, type InstalledExtension,
} from '@pushform/extensions';

/**
 * Installed extensions and their activity record on this device, in IndexedDB, one database per account so that
 * accounts sharing a browser never see each other's extensions.
 */
const STORE = 'extensions';
const ACTIVITY = 'activity';
const EGRESS = 'egress';
const VERSION = 2;

function open(name: string, factory: IDBFactory, onClose: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) db.createObjectStore(STORE, { keyPath: 'id' });
      if (event.oldVersion < 2) {
        db.createObjectStore(ACTIVITY, { keyPath: 'key' }).createIndex('extensionId', 'extensionId');
        db.createObjectStore(EGRESS, { keyPath: ['extensionId', 'origin'] }).createIndex('extensionId', 'extensionId');
      }
    };
    request.onsuccess = () => {
      // Another tab with a newer version asks to upgrade; let it.
      request.result.onversionchange = () => { request.result.close(); onClose(); };
      request.result.onclose = onClose;
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

/** One connection per account database, shared by the installed records and the activity record. */
const connections = new WeakMap<IDBFactory, Map<string, Promise<IDBDatabase>>>();
function database(ownerId: string, factory: IDBFactory): Promise<IDBDatabase> {
  const name = `pushform-extensions:${ownerId}`;
  const opened = connections.get(factory) ?? new Map<string, Promise<IDBDatabase>>();
  connections.set(factory, opened);
  let db = opened.get(name);
  if (!db) {
    // A connection that failed, or was closed for an upgrade elsewhere, is opened again next time.
    const forget = () => { if (opened.get(name) === db) opened.delete(name); };
    db = open(name, factory, forget);
    opened.set(name, db);
    db.catch(forget);
  }
  return db;
}

function transact<T>(db: () => Promise<IDBDatabase>, stores: string[], mode: IDBTransactionMode, action: (transaction: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return db().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(stores, mode);
    const request = action(transaction);
    transaction.oncomplete = () => resolve(request ? request.result : (undefined as T));
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}

const run = <T>(db: () => Promise<IDBDatabase>, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  transact(db, [STORE], mode, (t) => action(t.objectStore(STORE)));

export function indexedDbExtensionStore(ownerId: string, factory: IDBFactory = indexedDB): ExtensionStore {
  const db = () => database(ownerId, factory);
  return {
    list: () => run(db, 'readonly', (store) => store.getAll() as IDBRequest<InstalledExtension[]>),
    put: async (record) => { await run(db, 'readwrite', (store) => store.put(record)); },
    delete: async (id) => { await run(db, 'readwrite', (store) => store.delete(id)); },
  };
}

/** The activity record, bounded to the newest entries per extension and overall (`ACTIVITY_LIMITS`). */
export function indexedDbActivityStore(ownerId: string, factory: IDBFactory = indexedDB,
  limits: { perExtension: number; total: number } = ACTIVITY_LIMITS): ExtensionActivityStore {
  const db = () => database(ownerId, factory);
  return {
    put: (entry) => transact<void>(db, [ACTIVITY], 'readwrite', (t) => {
      const store = t.objectStore(ACTIVITY);
      store.put(entry);
      // The record is small and written rarely, so trimming reads it whole within the same transaction.
      const all = store.getAll() as IDBRequest<ActivityEntry[]>;
      all.onsuccess = () => { for (const key of activityOverflow(all.result, limits)) store.delete(key); };
    }),
    list: async (extensionId) => sortActivity(await transact(db, [ACTIVITY], 'readonly',
      (t) => t.objectStore(ACTIVITY).index('extensionId').getAll(extensionId) as IDBRequest<ActivityEntry[]>)),
    extensions: async () => {
      const [entries, totals] = await Promise.all([
        transact(db, [ACTIVITY], 'readonly', (t) => t.objectStore(ACTIVITY).getAll() as IDBRequest<ActivityEntry[]>),
        transact(db, [EGRESS], 'readonly', (t) => t.objectStore(EGRESS).getAll() as IDBRequest<EgressTotal[]>),
      ]);
      return [...new Set([...entries.map((e) => e.extensionId), ...totals.map((e) => e.extensionId)])];
    },
    addEgress: (extensionId, origin, traffic, at) => transact<void>(db, [EGRESS], 'readwrite', (t) => {
      const store = t.objectStore(EGRESS);
      const before = store.get([extensionId, origin]) as IDBRequest<EgressTotal | undefined>;
      before.onsuccess = () => {
        const previous = before.result;
        store.put({ extensionId, origin, ...addTraffic(previous, traffic), first: previous?.first ?? at, last: at } satisfies EgressTotal);
      };
    }),
    egress: async (extensionId) => (await transact(db, [EGRESS], 'readonly',
      (t) => t.objectStore(EGRESS).index('extensionId').getAll(extensionId) as IDBRequest<EgressTotal[]>)).sort((a, b) => a.origin.localeCompare(b.origin)),
    clear: (extensionId) => transact<void>(db, [ACTIVITY, EGRESS], 'readwrite', (t) => {
      for (const name of [ACTIVITY, EGRESS]) {
        const store = t.objectStore(name);
        const keys = store.index('extensionId').getAllKeys(extensionId);
        keys.onsuccess = () => { for (const key of keys.result) store.delete(key); };
      }
    }),
  };
}
