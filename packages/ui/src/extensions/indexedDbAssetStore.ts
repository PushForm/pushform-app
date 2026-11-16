// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError, assetDescriptionSchema, type AssetDescriptor } from '@pushform/extension-protocol';
import { assetConflict, assetQuota, type ExtensionAssetStore, type StoredExtensionAsset } from '@pushform/extensions';
const catalogs = 'catalog', blobs = 'blobs', counters = 'revisions';
interface Catalog { extensionId: string; asset: AssetDescriptor }
const opened = new WeakMap<IDBFactory, Map<string, Promise<IDBDatabase>>>();
function database(owner: string, factory: IDBFactory): Promise<IDBDatabase> {
  let owners = opened.get(factory); if (!owners) { owners = new Map(); opened.set(factory, owners); }
  let db = owners.get(owner);
  if (!db) {
    db = new Promise<IDBDatabase>((resolve,reject) => {
      const request = factory.open(`pushform:extension-assets:${owner}`,1);
      request.onupgradeneeded = () => { for (const name of [catalogs,blobs,counters]) request.result.createObjectStore(name); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Another tab is preventing asset storage from opening.'));
      request.onsuccess = () => { const database = request.result; database.onversionchange = () => { database.close(); owners!.delete(owner); }; resolve(database); };
    });
    owners.set(owner, db); db.catch(() => owners!.delete(owner));
  }
  return db;
}
function transaction<T>(db: Promise<IDBDatabase>, stores: string[], mode: IDBTransactionMode,
  action: (tx: IDBTransaction, result: (value: T) => void, fail: (cause: unknown) => void) => void, signal?: AbortSignal): Promise<T> {
  return db.then(database => new Promise<T>((resolve,reject) => {
    signal?.throwIfAborted();
    const tx = database.transaction(stores,mode); let value: T, failure: unknown;
    const cancel = () => { failure = signal?.reason; tx.abort(); };
    signal?.addEventListener('abort',cancel,{ once:true });
    const cleanup = () => signal?.removeEventListener('abort',cancel);
    tx.oncomplete = () => { cleanup(); resolve(value); }; tx.onabort = tx.onerror = () => { cleanup(); reject(failure ?? tx.error ?? new Error('The asset transaction was aborted.')); };
    const fail = (cause: unknown) => { failure = cause; tx.abort(); };
    try { action(tx, result => { value = result; }, fail); } catch (error) { fail(error); }
  }));
}
/** Separate catalog/blob stores keep listing and quota checks independent of potentially large image archives. */
export function indexedDbAssetStore(ownerId: string, factory: IDBFactory = indexedDB): ExtensionAssetStore {
  const db = () => database(ownerId,factory);
  return {
    list: (id,after,limit) => transaction(db(),[catalogs],'readonly',(tx,result) => {
      const query = tx.objectStore(catalogs).getAll() as IDBRequest<Catalog[]>;
      query.onsuccess = () => {
        const entries = query.result.filter(row => row.extensionId === id && (after === null || row.asset.key > after)).map(row => row.asset).sort((a,b) => a.key < b.key ? -1 : a.key === b.key ? 0 : 1);
        result({ entries: entries.slice(0,limit), next: entries.length > limit ? entries[limit - 1]!.key : null });
      };
    }),
    read: (id,key,signal) => transaction<StoredExtensionAsset | null>(db(),[catalogs,blobs],'readonly',(tx,result,fail) => {
      const description = tx.objectStore(catalogs).get([id,key]) as IDBRequest<Catalog | undefined>;
      description.onsuccess = () => {
        if (!description.result) { result(null); return; }
        const asset = description.result.asset, data = tx.objectStore(blobs).get([id,key]) as IDBRequest<Uint8Array | undefined>;
        data.onsuccess = () => { if (!data.result) fail(new ExtensionError('unavailable','The saved asset bytes are missing.')); else result({ asset, bytes: data.result }); };
      };
    },signal),
    put: async (id,description,bytes,expected,signal) => {
      signal?.throwIfAborted();
      const parsed = assetDescriptionSchema.parse(description);
      if (parsed.byteLength !== bytes.byteLength) throw new ExtensionError('validation.failed','The saved asset byte count does not match its description.');
      const owned = bytes.slice();
      return transaction<AssetDescriptor>(db(),[catalogs,blobs,counters],'readwrite',(tx,result,fail) => {
        const all = tx.objectStore(catalogs).getAll() as IDBRequest<Catalog[]>;
        all.onsuccess = () => {
          try {
            const previous = all.result.find(row => row.extensionId === id && row.asset.key === parsed.key)?.asset;
            if ((previous?.revision ?? null) !== expected) assetConflict();
            assetQuota(all.result,id,parsed);
            const revision = tx.objectStore(counters).get('account') as IDBRequest<number | undefined>;
            revision.onsuccess = () => {
              const next = (revision.result ?? 0) + 1, asset = { ...parsed, revision: next, updatedAt: new Date().toISOString() };
              tx.objectStore(counters).put(next,'account'); tx.objectStore(catalogs).put({ extensionId:id,asset },[id,parsed.key]); tx.objectStore(blobs).put(owned,[id,parsed.key]); result(asset);
            };
          } catch (error) { fail(error); }
        };
      },signal);
    },
    remove: (id,key,expected) => transaction(db(),[catalogs,blobs],'readwrite',(tx,result,fail) => {
      const found = tx.objectStore(catalogs).get([id,key]) as IDBRequest<Catalog | undefined>;
      found.onsuccess = () => {
        try { if (!found.result) { result(false); return; } if (found.result.asset.revision !== expected) assetConflict();
          tx.objectStore(catalogs).delete([id,key]); tx.objectStore(blobs).delete([id,key]); result(true);
        } catch (error) { fail(error); }
      };
    }),
    clear: id => transaction<void>(db(),[catalogs,blobs],'readwrite',(tx,result) => {
      const found = tx.objectStore(catalogs).getAll() as IDBRequest<Catalog[]>;
      found.onsuccess = () => { for (const row of found.result) if (row.extensionId === id) { tx.objectStore(catalogs).delete([id,row.asset.key]); tx.objectStore(blobs).delete([id,row.asset.key]); } result(undefined); };
    }),
  };
}
