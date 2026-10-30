// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { base64ToBytes, bytesToBase64, type ImageBlob } from '@pushform/model';

/**
 * Image bytes a document session keeps so that its model tabs reopen with their textures after a page refresh
 *, by content hash. Reads are synchronous: the session restores its tabs as it is created, so the
 * bytes it may need are read beforehand (`loadRefreshImages`). Writes may finish later.
 */
export interface RefreshImageStore {
  /** The kept bytes of an image, if any. */
  get(sha256: string): ImageBlob | undefined;
  /** Keep an image's bytes. Throws when they cannot be kept at all (a full session storage). */
  put(sha256: string, blob: ImageBlob): void;
  /** Forget an image no open tab uses. */
  delete(sha256: string): void;
}

/** Storage key of the refresh snapshot, and of an image kept in session storage (before IndexedDB was used). */
export const REFRESH_STORAGE_KEY = 'pushform:document-session:v2';
export const refreshImageKey = (sha256: string): string => `${REFRESH_STORAGE_KEY}:image:${sha256}`;
/** This browser tab's namespace for its images in IndexedDB, kept in its session storage. */
const REFRESH_TAB_KEY = `${REFRESH_STORAGE_KEY}:tab`;

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;

interface StoredImage {
  mime: string;
  /** Base64 bytes. */
  data: string;
}

/** An image kept in session storage, as base64 JSON; null when absent or damaged. */
function readStoredImage(storage: SessionStorageLike, sha256: string): ImageBlob | null {
  try {
    const raw = storage.getItem(refreshImageKey(sha256));
    const image = raw ? (JSON.parse(raw) as Partial<StoredImage>) : null;
    return typeof image?.mime === 'string' && typeof image.data === 'string' ? { mime: image.mime, bytes: base64ToBytes(image.data) } : null;
  } catch {
    return null;
  }
}

/**
 * Images kept in the tab's session storage beside the snapshot: about 5 MB per site in all, so large textures do
 * not fit. Used where IndexedDB is unavailable.
 */
export class SessionStorageRefreshImages implements RefreshImageStore {
  constructor(private readonly storage: SessionStorageLike) {}

  get(sha256: string): ImageBlob | undefined {
    return readStoredImage(this.storage, sha256) ?? undefined;
  }

  put(sha256: string, blob: ImageBlob): void {
    this.storage.setItem(refreshImageKey(sha256), JSON.stringify({ mime: blob.mime, data: bytesToBase64(blob.bytes) } satisfies StoredImage));
  }

  delete(sha256: string): void {
    this.storage.removeItem?.(refreshImageKey(sha256));
  }
}

const DB_NAME = 'pushform-refresh-images';
const DB_VERSION = 1;
/** Image records `{ key: "<tab>/<sha256>", tab, sha256, mime, bytes }`, and per tab the last time it wrote. */
const IMAGES = 'images';
const TABS = 'tabs';
/** Images of a browser tab that has not written for this long are removed: the tab is gone. */
export const REFRESH_IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface ImageRecord {
  key: string;
  tab: string;
  sha256: string;
  mime: string;
  bytes: Uint8Array;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Refresh image request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Refresh image write failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Refresh image write aborted'));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES, { keyPath: 'key' }).createIndex('tab', 'tab');
    if (!db.objectStoreNames.contains(TABS)) db.createObjectStore(TABS, { keyPath: 'tab' });
  };
  return requestResult(request);
}

/**
 * Images kept in IndexedDB, which holds textures of any size the import limits allow. Each browser tab writes
 * under its own namespace, so tabs never remove each other's images; a tab's images go when it removes them or
 * when it has not written for `REFRESH_IMAGE_TTL_MS`. Writes run in the background and failures are ignored: a
 * failed image shows its material's color after a refresh, as before.
 */
export class IndexedDbRefreshImages implements RefreshImageStore {
  private writes: Promise<void> = Promise.resolve();

  private constructor(private readonly factory: IDBFactory, private readonly tab: string,
    private readonly loaded: Map<string, ImageBlob>, private readonly now: () => number) {}

  /** Opens this tab's images and reads the `wanted` ones; removes the images of tabs gone for a week. */
  static async load(factory: IDBFactory, tab: string, wanted: Iterable<string>, now: () => number = Date.now): Promise<IndexedDbRefreshImages> {
    const loaded = new Map<string, ImageBlob>();
    const db = await openDb(factory);
    try {
      const read = db.transaction(IMAGES, 'readonly');
      const readDone = transactionDone(read);
      const images = read.objectStore(IMAGES);
      for (const sha256 of new Set(wanted)) {
        const record = await requestResult(images.get(`${tab}/${sha256}`) as IDBRequest<ImageRecord | undefined>);
        // Structured clones of another realm (a test environment) become this realm's arrays.
        if (record) loaded.set(sha256, { mime: record.mime, bytes: record.bytes instanceof Uint8Array ? record.bytes : new Uint8Array(record.bytes) });
      }
      await readDone;
      const sweep = db.transaction([IMAGES, TABS], 'readwrite');
      const sweepDone = transactionDone(sweep);
      const tabs = sweep.objectStore(TABS);
      const stale = (await requestResult(tabs.getAll() as IDBRequest<{ tab: string; touched: number }[]>))
        .filter(entry => entry.tab !== tab && now() - entry.touched > REFRESH_IMAGE_TTL_MS);
      for (const entry of stale) {
        const keys = await requestResult(sweep.objectStore(IMAGES).index('tab').getAllKeys(entry.tab));
        for (const key of keys) sweep.objectStore(IMAGES).delete(key);
        tabs.delete(entry.tab);
      }
      tabs.put({ tab, touched: now() });
      await sweepDone;
    } finally {
      db.close();
    }
    return new IndexedDbRefreshImages(factory, tab, loaded, now);
  }

  get(sha256: string): ImageBlob | undefined {
    return this.loaded.get(sha256);
  }

  put(sha256: string, blob: ImageBlob): void {
    this.loaded.set(sha256, blob);
    this.write(store => { store.objectStore(IMAGES).put({ key: `${this.tab}/${sha256}`, tab: this.tab, sha256, mime: blob.mime, bytes: blob.bytes } satisfies ImageRecord); });
  }

  delete(sha256: string): void {
    this.loaded.delete(sha256);
    this.write(store => { store.objectStore(IMAGES).delete(`${this.tab}/${sha256}`); });
  }

  /** Resolves when every write so far has finished (tests). */
  settled(): Promise<void> {
    return this.writes;
  }

  /** Queue one write, in order, and record that this tab is alive. */
  private write(change: (transaction: IDBTransaction) => void): void {
    this.writes = this.writes.then(async () => {
      const db = await openDb(this.factory);
      try {
        const transaction = db.transaction([IMAGES, TABS], 'readwrite');
        change(transaction);
        transaction.objectStore(TABS).put({ tab: this.tab, touched: this.now() });
        await transactionDone(transaction);
      } finally {
        db.close();
      }
    }).catch(() => {
      // A full disk or a closed database leaves that image without kept bytes; editing goes on.
    });
  }
}

/** The content hashes of the images the stored refresh snapshot refers to. */
function snapshotImages(storage: SessionStorageLike): string[] {
  try {
    const raw = storage.getItem(REFRESH_STORAGE_KEY);
    const snapshot = raw ? (JSON.parse(raw) as { tabs?: { images?: Record<string, unknown> }[] }) : null;
    return (snapshot?.tabs ?? []).flatMap(tab => Object.values(tab?.images ?? {}).filter((v): v is string => typeof v === 'string'));
  } catch {
    return [];
  }
}

/**
 * The image store a session restores from and keeps images in: IndexedDB when the browser offers it,
 * with the images the stored snapshot needs already read; else the session storage. Images an earlier version
 * kept in the session storage are read as well, then moved to IndexedDB by the session's next snapshot.
 */
export async function loadRefreshImages(storage: SessionStorageLike, factory: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB): Promise<RefreshImageStore> {
  if (!factory) return new SessionStorageRefreshImages(storage);
  try {
    let tab = storage.getItem(REFRESH_TAB_KEY);
    if (!tab) {
      tab = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      storage.setItem(REFRESH_TAB_KEY, tab);
    }
    const wanted = snapshotImages(storage);
    const images = await IndexedDbRefreshImages.load(factory, tab, wanted);
    for (const sha256 of wanted) {
      if (images.get(sha256)) continue;
      const legacy = readStoredImage(storage, sha256);
      if (legacy) images.put(sha256, legacy);
      storage.removeItem?.(refreshImageKey(sha256));
    }
    return images;
  } catch {
    return new SessionStorageRefreshImages(storage);
  }
}
