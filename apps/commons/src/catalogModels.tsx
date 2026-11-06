// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { CatalogLoader, CatalogModel } from './catalog';

/** The most models one by-ID request may name. */
const BATCH = 100;
const message = (error: unknown) => error instanceof Error ? error.message : 'Could not load these models. Try again.';

/** Public models fetched by ID for pages that show a known set of them: collections, credited creators and featured
 * picks. Those pages never read the whole catalog. Each model is requested once per visit, and the IDs asked for during
 * one render are combined into as few requests as possible. A catalog without by-ID reads (a static snapshot) is read
 * once and serves every lookup. */
export class CatalogModelStore {
  private models = new Map<string, CatalogModel | null>();
  private errors = new Map<string, string>();
  private queued = new Set<string>();
  private loading = new Set<string>();
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private snapshot: Promise<CatalogModel[]> | null = null;
  private version = 0;
  /** Changes when the catalog changes, so components ask again for what they show. */
  generation = 0;
  constructor(private readonly loader: CatalogLoader | null) {}
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getVersion = () => this.version;
  private changed() { this.version++; for (const listener of [...this.listeners]) listener(); }
  /** The model, `null` when it is not in the public catalog, or `undefined` while unknown. */
  get(id: string): CatalogModel | null | undefined { return this.models.get(id); }
  error(ids: readonly string[]): string | null { for (const id of ids) { const value = this.errors.get(id); if (value) return value; } return null; }
  request(ids: readonly string[]) {
    if (!this.loader) return;
    const wasEmpty = this.queued.size === 0;
    for (const id of ids) if (!this.models.has(id) && !this.loading.has(id) && !this.errors.has(id)) this.queued.add(id);
    if (wasEmpty && this.queued.size) queueMicrotask(() => this.flush());
  }
  /** Uses a complete catalog that was read anyway, instead of reading it again. */
  seed(models: readonly CatalogModel[]) {
    if (this.loader?.byIds) return;
    this.snapshot = Promise.resolve([...models]);
    for (const model of models) this.models.set(model.id, model);
    this.changed();
  }
  retry(ids: readonly string[]) { for (const id of ids) this.errors.delete(id); this.request(ids); this.changed(); }
  /** Forgets everything after a publish, edit or withdrawal. */
  reset() {
    this.controller.abort(); this.controller = new AbortController();
    this.models.clear(); this.errors.clear(); this.queued.clear(); this.loading.clear(); this.snapshot = null;
    this.generation++; this.changed();
  }
  private flush() {
    const ids = [...this.queued]; this.queued.clear();
    if (!ids.length || !this.loader) return;
    for (const id of ids) this.loading.add(id);
    const signal = this.controller.signal, byIds = this.loader.byIds;
    const requests = byIds
      ? Array.from({ length: Math.ceil(ids.length / BATCH) }, (_, index) => ids.slice(index * BATCH, index * BATCH + BATCH)).map(chunk => [chunk, byIds(chunk, signal)] as const)
      : [[ids, this.snapshot ??= this.loader(signal)] as const];
    for (const [chunk, request] of requests) {
      void request.then(found => {
        if (signal.aborted) return;
        for (const model of found) this.models.set(model.id, model);
        for (const id of chunk) if (!this.models.has(id)) this.models.set(id, null);
      }, error => {
        if (signal.aborted) return;
        if (!byIds) this.snapshot = null;
        for (const id of chunk) this.errors.set(id, message(error));
      }).finally(() => {
        if (signal.aborted) return;
        for (const id of chunk) this.loading.delete(id);
        this.changed();
      });
    }
    this.changed();
  }
}

const Context = createContext<CatalogModelStore | null>(null);
export function CatalogModelsProvider({ store, children }: { store: CatalogModelStore; children: ReactNode }) {
  useEffect(() => {
    const reset = () => store.reset();
    window.addEventListener('commons:catalog-changed', reset);
    return () => { window.removeEventListener('commons:catalog-changed', reset); };
  }, [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

const noSubscribe = () => () => {};
/** The public models among `ids`, in the order given; unavailable models are left out. */
export function useCatalogModels(ids: readonly string[]): { models: CatalogModel[]; missing: number; loading: boolean; error: string | null; retry: () => void } {
  const store = useContext(Context);
  const key = ids.join('\n');
  useSyncExternalStore(store?.subscribe ?? noSubscribe, () => store?.getVersion() ?? 0);
  const generation = store?.generation ?? 0;
  useEffect(() => { if (key) store?.request(key.split('\n')); }, [store, key, generation]);
  const wanted = key ? key.split('\n') : [];
  return {
    models: store ? wanted.map(id => store.get(id)).filter((model): model is CatalogModel => Boolean(model)) : [],
    missing: store ? wanted.filter(id => store.get(id) === null).length : 0,
    // Until the request goes out, a model nobody has asked about yet is also still loading.
    loading: Boolean(store) && wanted.some(id => store!.get(id) === undefined && !store!.error([id])),
    error: store?.error(wanted) ?? null,
    retry: () => store?.retry(wanted),
  };
}

/** Newest first, the order the library lists models in. */
export function newestFirst(models: readonly CatalogModel[]): CatalogModel[] {
  return [...models].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
}
