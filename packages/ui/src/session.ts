// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createLayoutTemplateState, createLayoutDocument, LayoutDocument } from '@pushform/layout';
import { createLayoutRegistry, ScriptRunner, type CommandRegistry } from '@pushform/commands';
import { newGuid } from '@pushform/core';
import type { DefId, ImageId } from '@pushform/core';
import { createDocument, ImageStore, type DocumentState, type ImageBlob } from '@pushform/model';
import {
  LAYOUT_FILE_EXTENSION,
  MODEL_FILE_EXTENSION,
  type OpenedLayoutFile,
  type OpenedModelFile,
  decodeLayoutJson,
  decodeModelSessionJson,
  encodeModelSnapshot, modelArchiveImages, encodeLayoutSnapshot, openLayoutFile, openModelFile,
  defaultLayoutRecoveryStore,
  importSketchUpLayout,
  isSketchUpLayoutFile,
  SKETCHUP_LAYOUT_EXTENSION,
  applySketchUpImport,
  modelImportBaseName,
  modelImportFormat,
  type SketchUpImport,
  type ModelImportReport,
  type SketchUpLayoutImport,
  type SketchUpLayoutProperties,
  type LayoutRecoveryMetadata,
  type LayoutRecoveryStore,
} from '@pushform/io';
import { DocumentLoading } from './documentLoading';
import { useAppStore, type AppState } from './store';
import type { AppInstance } from './bootstrap';
import { layoutContentJson, layoutContentKey, modelContentKey, modelSessionContentJson } from './documentContent';
import { REFRESH_STORAGE_KEY, SessionStorageRefreshImages, type RefreshImageStore } from './refreshImages';
import { NativeRefreshWriter, type NativeRefreshSession } from './nativeRefresh';

export interface CloudDraft { projectId?: string | undefined; folderId?: string | null | undefined; key?: string | undefined }

/** A version 4 UUID, also outside secure contexts where `crypto.randomUUID` is missing. */
export function newDraftKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface TabBase {
  readonly id: string;
  readonly type: 'model' | 'layout';
  name: string;
  readonly initialVersion: number;
  /**
   * First cloud save is still pending; retained across refresh, including its chosen project and the key that makes
   * a retried first save continue the same cloud document.
   */
  cloudDraft?: CloudDraft | undefined;
}

export interface ModelTab extends TabBase {
  readonly type: 'model';
  readonly app: AppInstance;
  workspace: AppState;
  savedContent: string;
  identity?: string;
}

export interface LayoutTab extends TabBase {
  readonly type: 'layout';
  readonly doc: LayoutDocument;
  readonly commands: CommandRegistry;
  activePageId: number;
  workspace: LayoutWorkspaceState;
  savedContent: string;
  recoveryId: string;
  identity?: string;
}

export type LayoutToolId =
  | 'shape-builder'
  | 'move'
  | 'rotate'
  | 'scale'
  | 'boolean-union' | 'boolean-subtract' | 'boolean-intersect' | 'boolean-exclude'
  | 'boolean-division' | 'boolean-cut-path'
  | 'fillet' | 'chamfer'
  | 'offset'
  | 'arc' | 'arc2' | 'arc3' | 'pie'
  | 'angular-dimension'
  | 'dimension'
  | 'text'
  | 'table'
  | 'viewport'
  | 'label'
  | 'select'
  | 'lasso'
  | 'line'
  | 'bezier'
  | 'rounded-rectangle'
  | 'bulged-rectangle'
  | 'lozenge'
  | 'rectangle'
  | 'circle'
  | 'ellipse'
  | 'polygon'
  | 'circumscribed-polygon'
  | 'freehand'
  | 'eraser';

/**
 * The object browser's expansion, kept with the tab so closing and reopening the browser keeps it: pages
 * are expanded unless collapsed, layers collapsed unless expanded, and groups and Models expanded unless collapsed.
 */
export interface LayoutBrowserView {
  readonly collapsedPages: ReadonlySet<number>;
  readonly expandedLayers: ReadonlySet<string>;
  readonly collapsedGroups: ReadonlySet<string>;
  readonly settingsOpen: boolean;
}

/** Runtime-only state; never serialized into .pfl. */
export interface LayoutWorkspaceState {
  browserView?: LayoutBrowserView;
  tool: LayoutToolId;
  zoom: number;
  zoomToPageOnOpen?: boolean;
  selectedEntityId: number | null;
  anchor: [number, number] | null;
  vcbDraft: string;
}

function createLayoutWorkspaceState(): LayoutWorkspaceState {
  return { tool: 'select', zoom: 1, selectedEntityId: null, anchor: null, vcbDraft: '' };
}

export type DocumentTab = ModelTab | LayoutTab;

/** Storage a session uses to reopen its tabs after a page refresh. */
export type RefreshStorage = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;

interface RefreshLayoutTab {
  dirty?: boolean;
  type: 'layout';
  name: string;
  recoveryId: string;
  content: string;
  savedContent: string;
  activePageId: number;
  identity?: string;
  cloudDraft?: CloudDraft;
}

interface RefreshModelTab {
  type: 'model';
  name: string;
  content: string;
  dirty: boolean;
  savedContent?: string;
  identity?: string;
  cloudDraft?: CloudDraft;
  /** Image asset id -> content hash of the bytes kept in the session's `RefreshImageStore`. */
  images?: Record<string, string>;
}

interface RefreshSnapshot {
  version: 2;
  activeIndex: number;
  tabs: (RefreshLayoutTab | RefreshModelTab)[];
}

/**
 * Refresh snapshots are written this long after the session change that made them stale, so a
 * burst of notifications (activation, page switch, save completion, edits) persists once, outside
 * the interaction handler. Leaving the page requests a final checkpoint; binary persistence is
 * asynchronous, so only a completed checkpoint is guaranteed to survive an immediate shutdown.
 */
export const REFRESH_PERSIST_DELAY_MS = 300;
/** A refresh checkpoint waits at least this many times as long as the last one took to encode, so a large document
 * is not re-encoded continuously while it is edited; never longer than a minute. */
export const REFRESH_PERSIST_COST_FACTOR = 5, REFRESH_PERSIST_MAX_DELAY_MS = 60_000;

/** One tab's entry of the refresh snapshot, already serialized, with the inputs it was built from. */
interface RefreshFragment {
  state: object;
  name: string;
  savedContent: string;
  activePageId: number;
  identity: string | undefined;
  projectId: string | undefined;
  folderId: string | null | undefined;
  hasDraft: boolean;
  draftKey: string | undefined;
  /** Image asset id -> content hash kept for refresh (model tabs). */
  images: Record<string, string> | undefined;
  imagesKey: string;
  json: string;
}

/** Runtime tab ownership, file identity, and recoverable Layout drafts. */
export class DocumentSession {
  readonly loading = new DocumentLoading();
  readonly scripts = new ScriptRunner(() => this.activeCommands);
  private _tabs: DocumentTab[];
  private _activeId: string;
  private sequence = 1;
  private _revision = 0;
  private restoredSnapshot = false;
  private listeners = new Set<() => void>();
  private offs = new Map<string, () => void>();
  private recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private recoveryTasks = new Map<string, Promise<void>>();
  private pendingRecovery = new Map<string, () => Promise<void>>();
  private orphanInitialApp: AppInstance | null = null;
  /** Content hashes whose image bytes are kept for refresh, and those that could not be kept. */
  private refreshImages = new Set<string>();
  private refreshImagesTooLarge = new Set<string>();
  /** Refresh persistence: pending flush, per-tab serialized entries, and the last assembled snapshot. */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshStale = false;
  /** How long the last checkpoint's slowest document took to encode (ms). */
  private refreshCostMs = 0;
  private refreshFragments = new Map<string, RefreshFragment>();
  private lastRefreshSnapshot: { parts: readonly string[]; activeIndex: number; text: string } | null = null;
  /** The snapshot the storage accepted, and the tab contents it rejected (not retried until one changes). */
  private refreshWritten: { parts: readonly string[]; activeIndex: number } | null = null;
  private refreshRejected: { parts: readonly string[] } | null = null;
  private readonly flushOnLeave = (): void => this.flushRefreshPersistence();
  private nativeWriter: NativeRefreshWriter | undefined;
  recoveryError: string | null = null;

  constructor(
    private readonly initialApp: AppInstance,
    private readonly createModelApp: () => AppInstance,
    private readonly ownsInitial = false,
    private readonly recoveryStore: LayoutRecoveryStore | null = defaultLayoutRecoveryStore(),
    private readonly refreshStorage: RefreshStorage | null = null,
    /** Where image bytes are kept for refresh; `loadRefreshImages` gives IndexedDB. */
    private readonly refreshImageStore: RefreshImageStore | null = refreshStorage ? new SessionStorageRefreshImages(refreshStorage) : null,
    private readonly nativeRefresh?: NativeRefreshSession,
  ) {
    const id = this.nextId();
    this._tabs = [
      {
        id,
        type: 'model',
        name: `Untitled${MODEL_FILE_EXTENSION}`,
        app: initialApp,
        initialVersion: initialApp.document.doc.version,
        workspace: { ...useAppStore.getState() },
        savedContent: modelContentKey(initialApp.document.doc),
      },
    ];
    this._activeId = id;
    if (nativeRefresh) this.nativeWriter = new NativeRefreshWriter(nativeRefresh.store, error => {
      this.recoveryError = error instanceof Error ? error.message : 'Native recovery failed';
      // Do not emit here: a failed persistence write must not schedule itself indefinitely.
    });
    this.watch(this._tabs[0]!);
    this.restoreForRefresh();
    this.nativeRefresh?.files.clear();
    if (this.refreshStorage && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', this.flushOnLeave);
      window.addEventListener('beforeunload', this.flushOnLeave);
    }
    this.scheduleRefreshPersistence();
  }

  /** Whether this session successfully recovered document tabs from this browser tab's refresh snapshot. */
  get restoredForRefresh(): boolean { return this.restoredSnapshot; }

  get tabs(): readonly DocumentTab[] {
    return this._tabs;
  }
  get activeId(): string {
    return this._activeId;
  }
  get active(): DocumentTab {
    return this._tabs.find((t) => t.id === this._activeId)!;
  }
  get activeCommands(): CommandRegistry {
    const tab = this.active;
    return tab.type === 'model' ? tab.app.commands : tab.commands;
  }
  get revision(): number {
    return this._revision;
  }
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /**
   * Content comparison against the saved baseline: undo back to the saved content reads as clean,
   * and a save marks only the content it captured. The current content is cached per
   * document state, so repeated checks of an unchanged document do not serialize it again.
   */
  isDirty(tab: DocumentTab): boolean {
    if (tab.type === 'layout') return layoutContentKey(tab.doc) !== tab.savedContent;
    return modelContentKey(tab.app.document.doc) !== tab.savedContent;
  }

  setCloudDraft(id: string, projectId?: string, folderId?: string | null): void {
    const tab = this._tabs.find(item => item.id === id);
    if (!tab) return;
    // The key outlives a change of destination: an earlier attempt may already have created the document.
    const key = tab.cloudDraft?.key ?? newDraftKey();
    tab.cloudDraft = projectId ? { projectId, ...(folderId ? { folderId } : {}), key } : { key };
    this.emit();
  }

  newModel(): ModelTab {
    this.parkActive();
    const app = this.createModelApp();
    const tab: ModelTab = {
      id: this.nextId(),
      type: 'model',
      name: `Untitled ${this.sequence - 1}${MODEL_FILE_EXTENSION}`,
      app,
      initialVersion: app.document.doc.version,
      workspace: { ...useAppStore.getState() },
      savedContent: modelContentKey(app.document.doc),
    };
    this._tabs = [...this._tabs, tab];
    this.watch(tab);
    this._activeId = tab.id;
    this.emit();
    return tab;
  }

  newLayout(templateId?: string): LayoutTab {
    const doc = templateId ? new LayoutDocument(createLayoutTemplateState(templateId)) : createLayoutDocument();
    this.parkActive();
    const { commands } = createLayoutRegistry(doc);
    const tab: LayoutTab = {
      id: this.nextId(),
      type: 'layout',
      name: `Untitled ${this.sequence - 1}${LAYOUT_FILE_EXTENSION}`,
      doc,
      commands,
      initialVersion: doc.version,
      activePageId: doc.state.pageOrder[0]!,
      workspace: createLayoutWorkspaceState(),
      savedContent: layoutContentKey(doc),
      recoveryId: newGuid(),
    };
    this._tabs = [...this._tabs, tab];
    this.watch(tab);
    this._activeId = tab.id;
    this.emit();
    return tab;
  }

  async openLayoutBytes(bytes: Uint8Array, name: string, identity?: string): Promise<LayoutTab> {
    const existing = this.existingLayoutTab(identity);
    if (existing) return existing;
    return this.loading.run(name, 'Reading drawing…', async stage => {
      const opened = await openLayoutFile(bytes);
      await stage('Preparing workspace…');
      return this.openLayoutFile(opened, name, identity);
    });
  }

  /** Open a .pfl decoded off the UI thread; its semantic identity is the saved baseline. */
  openLayoutFile(opened: OpenedLayoutFile, name: string, identity?: string): LayoutTab {
    const existing = this.existingLayoutTab(identity);
    if (existing) return existing;
    const doc = new LayoutDocument(opened.state);
    layoutContentKey.prime(doc, opened.contentIdentity);
    return this.addLayoutTab(doc, name.endsWith(LAYOUT_FILE_EXTENSION) ? name : `${name}${LAYOUT_FILE_EXTENSION}`, opened.contentIdentity, identity);
  }

  /** Instantiate saved template content with a fresh document identity and empty undo history. */
  newLayoutFromTemplate(opened: OpenedLayoutFile, projectId: string, folderId: string | null): LayoutTab {
    const doc = new LayoutDocument({ ...opened.state, meta: { ...opened.state.meta, guid: newGuid() } });
    return this.addLayoutTab(doc, `Untitled ${this.sequence}${LAYOUT_FILE_EXTENSION}`, layoutContentKey(doc), undefined,
      { projectId, folderId, key: newDraftKey() });
  }

  private existingLayoutTab(identity: string | undefined): LayoutTab | undefined {
    if (!identity) return undefined;
    const existing = this._tabs.find((tab) => tab.type === 'layout' && tab.identity === identity);
    if (existing?.type !== 'layout') return undefined;
    this.activate(existing.id);
    return existing;
  }

  /**
   * Convert a SketchUp LayOut file into a new, unsaved Layout tab. It has no file identity, so
   * saving writes a .pfl rather than overwriting the original.
   */
  importSketchUpLayout(source: Uint8Array | SketchUpLayoutImport, name: string): { tab: LayoutTab; warnings: string[]; properties: SketchUpLayoutProperties } {
    // Bytes convert inline (headless callers); the browser open path converts in a worker and passes the result.
    const { doc, warnings, properties } = source instanceof Uint8Array ? importSketchUpLayout(source, name) : source;
    const base = isSketchUpLayoutFile(name) ? name.slice(0, -SKETCHUP_LAYOUT_EXTENSION.length) : name;
    // An empty saved baseline keeps the converted document dirty until it is saved as .pfl.
    return { tab: this.addLayoutTab(doc, `${base}${LAYOUT_FILE_EXTENSION}`, ''), warnings, properties };
  }

  private addLayoutTab(doc: LayoutDocument, name: string, savedContent: string, identity?: string, cloudDraft?: CloudDraft): LayoutTab {
    const { commands } = createLayoutRegistry(doc);
    this.parkActive();
    const tab: LayoutTab = {
      id: this.nextId(),
      type: 'layout',
      name,
      doc,
      commands,
      initialVersion: doc.version,
      activePageId: doc.state.pageOrder[0]!,
      workspace: { ...createLayoutWorkspaceState(), zoomToPageOnOpen: true },
      savedContent,
      recoveryId: newGuid(),
      ...(identity ? { identity } : {}),
      ...(cloudDraft ? { cloudDraft } : {}),
    };
    this._tabs = [...this._tabs, tab];
    this.watch(tab);
    this._activeId = tab.id;
    this.emit();
    return tab;
  }

  async openModelBytes(bytes: Uint8Array, name: string, identity?: string): Promise<ModelTab> {
    const existing = this.existingModelTab(identity);
    if (existing) return existing;
    return this.loading.run(name, 'Reading model…', async stage => {
      const opened = await openModelFile(bytes);
      await stage('Preparing workspace…');
      return this.openModelFile(opened, name, identity);
    });
  }

  /** Open a .pf decoded off the UI thread; its semantic identity is the saved baseline. */
  openModelFile(opened: OpenedModelFile, name: string, identity?: string): ModelTab {
    const existing = this.existingModelTab(identity);
    if (existing) return existing;
    const tab = this.addModelTab(opened.state, name, opened.contentIdentity, identity, opened.images, true);
    tab.app.viewport.camera.zoomExtents();
    return tab;
  }

  private existingModelTab(identity: string | undefined): ModelTab | undefined {
    if (!identity) return undefined;
    const existing = this._tabs.find((tab) => tab.type === 'model' && tab.identity === identity);
    if (existing?.type !== 'model') return undefined;
    this.activate(existing.id);
    return existing;
  }

  /** Converted files never retain a source handle: Save writes .pf and cannot overwrite .skp/.skb/.dae. */
  openSketchUpModel(scene: SketchUpImport, name: string): { tab: ModelTab; report: ModelImportReport } {
    const doc = createDocument();
    const images = new ImageStore();
    const report = doc.transact(`Open ${modelImportFormat(name).name} model`, draft => applySketchUpImport(draft, scene, { images })).value;
    const tab = this.addModelTab(doc.state, `${modelImportBaseName(name)}${MODEL_FILE_EXTENSION}`, '', undefined,
      new Map([...images.entries()].map(([id, entry]) => [id, entry.blob])));
    tab.app.viewport.camera.zoomExtents();
    return { tab, report };
  }

  importSketchUpModel(scene: SketchUpImport, name: string, tabId: string, definitionId: DefId): ModelImportReport {
    const tab = this._tabs.find(t => t.id === tabId);
    if (!tab || tab.type !== 'model') throw new Error('The import destination was closed.');
    const report = tab.app.document.edit(`Import ${modelImportFormat(name).name} model`, draft => applySketchUpImport(draft, scene,
      { definitionId, groupName: modelImportBaseName(name), images: tab.app.document.images }));
    tab.app.viewport.camera.zoomExtents();
    return report;
  }

  /**
   * `savedContent` null: the opened state's semantic identity is the saved baseline.
   * `canonical`: the worker computed this identity for `state`, so the first dirty check needs no hashing.
   */
  private addModelTab(state: DocumentState, name: string, savedContent: string | null, identity?: string,
    images?: ReadonlyMap<ImageId, ImageBlob>, canonical = false): ModelTab {
    const app = this.createModelApp();
    try {
      // Bytes first: rendering the new state resolves texture URLs once per material map.
      for (const [id, blob] of images ?? []) {
        const asset = state.images.get(id);
        if (asset) app.document.images.register(asset, blob.bytes, blob.mime);
      }
      app.document.doc.replaceState(state, 'open model');
      if (canonical && savedContent !== null) modelContentKey.prime(app.document.doc, savedContent);
    } catch (cause) {
      app.dispose();
      throw cause;
    }
    this.parkActive();
    const tab: ModelTab = {
      id: this.nextId(),
      type: 'model',
      name: name.endsWith(MODEL_FILE_EXTENSION) ? name : `${name}${MODEL_FILE_EXTENSION}`,
      app,
      initialVersion: app.document.doc.version,
      workspace: { ...useAppStore.getState() },
      savedContent: savedContent ?? modelContentKey(app.document.doc),
      ...(identity ? { identity } : {}),
    };
    this._tabs = [...this._tabs, tab];
    this.watch(tab);
    this._activeId = tab.id;
    useAppStore.setState(tab.workspace);
    this.emit();
    return tab;
  }

  async listLayoutRecoveries(): Promise<LayoutRecoveryMetadata[]> {
    if (!this.recoveryStore) return [];
    const openIds = new Set(
      this._tabs.filter((tab): tab is LayoutTab => tab.type === 'layout').map((tab) => tab.recoveryId),
    );
    return (await this.recoveryStore.list()).filter((record) => !openIds.has(record.id));
  }

  async restoreLayoutRecovery(metadata: LayoutRecoveryMetadata): Promise<LayoutTab> {
    const existing = this._tabs.find((tab): tab is LayoutTab => tab.type === 'layout' && tab.recoveryId === metadata.id);
    if (existing) { this.activate(existing.id); return existing; }
    const record = await this.recoveryStore?.read(metadata.id);
    if (!record) throw new Error('This Layout recovery draft is no longer available');
    const opened = await openLayoutFile(record.bytes);
    const tab = this.openLayoutFile(opened, record.name);
    tab.savedContent = record.savedContent;
    tab.recoveryId = record.id;
    this.emit();
    return tab;
  }

  discardLayoutRecovery(id: string): void {
    if (this.recoveryStore) this.queueRecovery(id, () => this.recoveryStore!.delete(id));
  }

  async saveLayoutBytes(id: string, name?: string, identity?: string): Promise<Uint8Array> {
    const tab = this._tabs.find((item) => item.id === id);
    if (!tab || tab.type !== 'layout') throw new Error('Unknown Layout tab');
    const state = tab.doc.state, savedContent = layoutContentKey(tab.doc);
    const bytes = await encodeLayoutSnapshot(state);
    if (this._tabs.includes(tab)) this.markLayoutSaved(id, name, identity, savedContent);
    return bytes;
  }

  async saveModelBytes(id: string, name?: string, identity?: string): Promise<Uint8Array> {
    const tab = this._tabs.find((item) => item.id === id);
    if (!tab || tab.type !== 'model') throw new Error('Unknown Modeling tab');
    const state = tab.app.document.doc.state;
    const savedContent = modelContentKey(tab.app.document.doc);
    const bytes = await encodeModelSnapshot(state, modelArchiveImages(state, tab.app.document.images));
    // Edits during encoding stay dirty; closing the tab does not invalidate the completed download.
    if (this._tabs.includes(tab)) this.markModelSaved(id, name, identity, savedContent);
    return bytes;
  }

  /** Rename workspace metadata without changing geometry or the saved content baseline. */
  rename(id: string, name: string): void {
    const tab = this._tabs.find(item => item.id === id);
    const trimmed = name.trim();
    if (!tab || !trimmed) return;
    const extension = tab.type === 'model' ? MODEL_FILE_EXTENSION : LAYOUT_FILE_EXTENSION;
    tab.name = trimmed.toLowerCase().endsWith(extension) ? trimmed : `${trimmed}${extension}`;
    this.emit();
  }

  markModelSaved(id: string, name?: string, identity?: string | null, savedContent?: string): void {
    const tab = this._tabs.find((item) => item.id === id);
    if (!tab || tab.type !== 'model') throw new Error('Unknown Modeling tab');
    delete tab.cloudDraft;
    if (name)
      tab.name = name.endsWith(MODEL_FILE_EXTENSION) ? name : `${name}${MODEL_FILE_EXTENSION}`;
    if (identity === null) delete tab.identity;
    else if (identity) tab.identity = identity;
    tab.savedContent = savedContent ?? modelContentKey(tab.app.document.doc);
    this.emit();
  }

  markLayoutSaved(id: string, name?: string, identity?: string | null, savedContent?: string): void {
    const tab = this._tabs.find((item) => item.id === id);
    if (!tab || tab.type !== 'layout') throw new Error('Unknown Layout tab');
    delete tab.cloudDraft;
    if (name)
      tab.name = name.endsWith(LAYOUT_FILE_EXTENSION) ? name : `${name}${LAYOUT_FILE_EXTENSION}`;
    if (identity === null) delete tab.identity;
    else if (identity) tab.identity = identity;
    tab.savedContent = savedContent ?? layoutContentKey(tab.doc);
    this.cancelRecoveryTimer(tab.recoveryId);
    if (this.recoveryStore) this.queueRecovery(tab.recoveryId, () => this.recoveryStore!.delete(tab.recoveryId));
    if (this.isDirty(tab)) this.scheduleRecovery(tab);
    this.emit();
  }

  /** Drain debounced snapshots, useful for app shutdown and deterministic tests. */
  async flushLayoutRecovery(): Promise<void> {
    for (const tab of this._tabs) {
      if (tab.type === 'layout' && this.recoveryTimers.has(tab.recoveryId)) {
        this.cancelRecoveryTimer(tab.recoveryId);
        this.writeRecovery(tab);
      }
    }
    await Promise.all(this.recoveryTasks.values());
  }

  reorderTab(id: string, toIndex: number): boolean {
    const from = this._tabs.findIndex((tab) => tab.id === id);
    if (from < 0 || toIndex < 0 || toIndex >= this._tabs.length) return false;
    const next = [...this._tabs];
    const [tab] = next.splice(from, 1);
    next.splice(toIndex, 0, tab!);
    this._tabs = next;
    this.emit();
    return true;
  }

  activate(id: string): boolean {
    const next = this._tabs.find((t) => t.id === id);
    if (!next) return false;
    if (id === this._activeId) return true;
    this.parkActive();
    this._activeId = id;
    if (next.type === 'model') useAppStore.setState(next.workspace);
    this.emit();
    return true;
  }

  /** The caller must resolve the save/discard decision before passing discardChanges. */
  close(id: string, discardChanges = false): boolean {
    const index = this._tabs.findIndex((t) => t.id === id);
    if (index < 0 || this._tabs.length === 1) return false;
    const tab = this._tabs[index]!;
    if (this.isDirty(tab) && !discardChanges) return false;
    const wasActive = id === this._activeId;
    if (wasActive) this.parkActive();
    this._tabs = this._tabs.filter((t) => t.id !== id);
    if (wasActive) {
      const next = this._tabs[Math.min(index, this._tabs.length - 1)]!;
      this._activeId = next.id;
      if (next.type === 'model') useAppStore.setState(next.workspace);
    }
    this.offs.get(id)?.();
    this.offs.delete(id);
    if (tab.type === 'layout') {
      this.cancelRecoveryTimer(tab.recoveryId);
      if (this.recoveryStore) this.queueRecovery(tab.recoveryId, () => this.recoveryStore!.delete(tab.recoveryId));
    }
    if (tab.type === 'model' && (tab.app !== this.initialApp || this.ownsInitial)) tab.app.dispose();
    this.emit();
    return true;
  }

  setActivePage(id: number): boolean {
    const tab = this.active;
    if (tab.type !== 'layout' || !tab.doc.state.pages.has(id)) return false;
    tab.activePageId = id;
    this.emit();
    return true;
  }

  dispose(): void {
    void this.flushLayoutRecovery();
    // Before any app is disposed: the snapshot reads live document state.
    this.flushRefreshPersistence();
    if (this.refreshStorage && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', this.flushOnLeave);
      window.removeEventListener('beforeunload', this.flushOnLeave);
    }
    for (const off of this.offs.values()) off();
    for (const tab of this._tabs) {
      if (tab.type === 'model' && (tab.app !== this.initialApp || this.ownsInitial)) tab.app.dispose();
    }
    if (this.orphanInitialApp && this.ownsInitial) this.orphanInitialApp.dispose();
    this.listeners.clear();
  }

  private parkActive(): void {
    const tab = this.active;
    if (tab.type === 'model') tab.workspace = { ...useAppStore.getState() };
  }

  private watch(tab: DocumentTab): void {
    const doc = tab.type === 'model' ? tab.app.document.doc : tab.doc;
    this.offs.set(
      tab.id,
      doc.events.on('change', () => {
        this.emit();
        if (tab.type === 'layout') this.scheduleRecovery(tab);
      }),
    );
  }

  private scheduleRecovery(tab: LayoutTab): void {
    if (!this.recoveryStore) return;
    this.cancelRecoveryTimer(tab.recoveryId);
    this.recoveryTimers.set(tab.recoveryId, setTimeout(() => {
      this.recoveryTimers.delete(tab.recoveryId);
      if (this._tabs.includes(tab)) this.writeRecovery(tab);
    }, 500));
  }

  private writeRecovery(tab: LayoutTab): void {
    if (!this.recoveryStore) return;
    const id = tab.recoveryId;
    if (!this.isDirty(tab)) {
      this.queueRecovery(id, () => this.recoveryStore!.delete(id));
      return;
    }
    const state = tab.doc.state;
    const metadata = {
      id,
      name: tab.name,
      savedContent: tab.savedContent,
      modifiedAt: Date.now(),
    };
    this.queueRecovery(id, async () => {
      const bytes = await encodeLayoutSnapshot(state);
      await this.recoveryStore!.put({ ...metadata, bytes });
    });
  }

  private cancelRecoveryTimer(id: string): void {
    const timer = this.recoveryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.recoveryTimers.delete(id);
  }

  private queueRecovery(id: string, run: () => Promise<void>): void {
    // Keep one active revision and only the latest pending operation for this document.
    // A save/close deletion supersedes queued snapshots but runs after the active write.
    this.pendingRecovery.set(id, run);
    if (this.recoveryTasks.has(id)) return;
    const task = Promise.resolve().then(async () => {
      try {
        while (this.pendingRecovery.has(id)) {
          const next = this.pendingRecovery.get(id)!;
          this.pendingRecovery.delete(id);
          try { await next(); }
          catch (error) {
            this.recoveryError = error instanceof Error ? error.message : 'Layout recovery failed';
            this.emit();
          }
        }
      } finally { this.recoveryTasks.delete(id); }
    });
    this.recoveryTasks.set(id, task);
  }

  private nextId(): string {
    return `tab-${this.sequence++}`;
  }

  private restoreForRefresh(): void {
    if (!this.refreshStorage) return;
    try {
      const raw = this.nativeRefresh ? null : this.refreshStorage.getItem(REFRESH_STORAGE_KEY);
      const nativeHead = this.nativeRefresh?.head;
      if (!raw && !nativeHead) return;
      const snapshot: Partial<RefreshSnapshot> = nativeHead ? { version: 2, activeIndex: nativeHead.activeIndex,
        tabs: nativeHead.entries.map(e => {
          try { return { ...JSON.parse(e.metadata), content: e.id }; }
          catch { return null; }
        }) as RefreshSnapshot['tabs'] } : JSON.parse(raw!) as Partial<RefreshSnapshot>;
      if (snapshot.version !== 2 || !Array.isArray(snapshot.tabs) || !snapshot.tabs.length) return;
      this.offs.get(this._tabs[0]!.id)?.();
      this.offs.clear();
      const restored: DocumentTab[] = [];
      const seen = new Set<string>();
      let firstModelUsed = false;
      let activeId: string | null = null;
      for (const [index, item] of snapshot.tabs.entries()) {
        if (!item || typeof item.name !== 'string' || typeof item.content !== 'string') continue;
        try {
          if (item.type === 'model') {
            const loaded = this.nativeRefresh?.files.get(item.content);
            if (this.nativeRefresh && loaded?.kind !== 'model') continue;
            const opened = loaded?.kind === 'model' ? loaded.file : undefined;
            const state = opened?.state ?? decodeModelSessionJson(item.content);
            const app = firstModelUsed ? this.createModelApp() : this.initialApp;
            // Bytes first, as when opening a file: rendering the state resolves texture URLs.
            if (opened) for (const [id, blob] of opened.images) { const asset = state.images.get(id); if (asset) app.document.images.register(asset, blob.bytes, blob.mime); }
            else this.restoreRefreshImages(state, item.images, app.document.images);
            app.document.doc.replaceState(state, 'restore session');
            if (opened) modelContentKey.prime(app.document.doc, opened.contentIdentity);
            if (opened) app.viewport.camera.zoomExtents();
            firstModelUsed = true;
            const tab: ModelTab = {
              id: this.nextId(), type: 'model', name: item.name,
              app, initialVersion: app.document.doc.version,
              workspace: { ...useAppStore.getState() },
              savedContent: item.dirty ? (typeof item.savedContent === 'string' ? item.savedContent : '') : modelContentKey(app.document.doc),
              ...(typeof item.identity === 'string' ? { identity: item.identity } : {}),
              ...(item.cloudDraft && typeof item.cloudDraft === 'object' ? { cloudDraft: {
                ...(typeof item.cloudDraft.projectId === 'string' ? { projectId: item.cloudDraft.projectId } : {}),
                ...(typeof item.cloudDraft.folderId === 'string' ? { folderId: item.cloudDraft.folderId } : {}),
                ...(typeof item.cloudDraft.key === 'string' ? { key: item.cloudDraft.key } : {}),
              } } : {}),
            };
            restored.push(tab);
            if (snapshot.activeIndex === index) activeId = tab.id;
            continue;
          }
          if (item.type !== 'layout' || typeof item.recoveryId !== 'string' ||
              typeof item.savedContent !== 'string' || seen.has(item.recoveryId)) continue;
          const loaded = this.nativeRefresh?.files.get(item.content);
          if (this.nativeRefresh && loaded?.kind !== 'layout') continue;
          const doc = loaded?.kind === 'layout' ? new LayoutDocument(loaded.file.state) : decodeLayoutJson(item.content);
          if (loaded?.kind === 'layout') layoutContentKey.prime(doc, loaded.file.contentIdentity);
          const { commands } = createLayoutRegistry(doc);
          const tab: LayoutTab = {
            id: this.nextId(),
            type: 'layout',
            name: item.name,
            doc,
            commands,
            initialVersion: doc.version,
            activePageId: doc.state.pages.has(item.activePageId)
              ? item.activePageId : doc.state.pageOrder[0]!,
            workspace: { ...createLayoutWorkspaceState(), zoomToPageOnOpen: true },
            savedContent: this.nativeRefresh ? item.dirty ? '' : layoutContentKey(doc) : item.savedContent,
            recoveryId: item.recoveryId,
            ...(typeof item.identity === 'string' ? { identity: item.identity } : {}),
            ...(item.cloudDraft && typeof item.cloudDraft === 'object' ? { cloudDraft: {
              ...(typeof item.cloudDraft.projectId === 'string' ? { projectId: item.cloudDraft.projectId } : {}),
              ...(typeof item.cloudDraft.folderId === 'string' ? { folderId: item.cloudDraft.folderId } : {}),
              ...(typeof item.cloudDraft.key === 'string' ? { key: item.cloudDraft.key } : {}),
            } } : {}),
          };
          restored.push(tab);
          seen.add(tab.recoveryId);
          if (snapshot.activeIndex === index) activeId = tab.id;
        } catch {
          // One damaged tab must not prevent other tabs from opening.
        }
      }
      if (!restored.length) {
        this.watch(this._tabs[0]!);
        return;
      }
      this._tabs = restored;
      this.restoredSnapshot = true;
      this._activeId = activeId ?? restored[0]!.id;
      for (const tab of restored) this.watch(tab);
      if (!firstModelUsed) this.orphanInitialApp = this.initialApp;
      if (this.active.type === 'model') useAppStore.setState(this.active.workspace);
    } catch {
      // Storage can be unavailable or contain malformed data.
      if (!this.offs.has(this._tabs[0]!.id)) this.watch(this._tabs[0]!);
    }
  }

  /** Mark the refresh snapshot stale and flush it once, after `REFRESH_PERSIST_DELAY_MS` or longer for a document
   * that is slow to encode (`REFRESH_PERSIST_COST_FACTOR`). */
  private scheduleRefreshPersistence(): void {
    if (!this.refreshStorage) return;
    this.refreshStale = true;
    if (this.refreshTimer !== null) return;
    const delay = Math.min(REFRESH_PERSIST_MAX_DELAY_MS, Math.max(REFRESH_PERSIST_DELAY_MS, this.refreshCostMs * REFRESH_PERSIST_COST_FACTOR));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.flushRefreshPersistence();
    }, delay);
  }

  /** `encode`, timed: the slowest document of a checkpoint sets how soon the next one may start. */
  private timedEncode(encode: () => Promise<Uint8Array>): () => Promise<Uint8Array> {
    return async () => {
      const began = performance.now();
      try { return await encode(); } finally { this.refreshCostMs = Math.max(this.refreshCostMs, performance.now() - began); }
    };
  }

  /**
   * Write the refresh snapshot now if the session changed since the last write. Runs on the
   * scheduled flush, on `pagehide`/`beforeunload`, and in `dispose()`. Tab entries whose inputs
   * are unchanged are reused as serialized; a snapshot the storage rejected (quota) is not
   * offered again until its content changes.
   */
  flushRefreshPersistence(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (!this.refreshStorage || !this.refreshStale) return;
    this.refreshStale = false;
    if (this.nativeWriter) {
      this.nativeWriter.request({ activeIndex: this._tabs.indexOf(this.active), entries: this._tabs.map(tab => {
        const metadata = JSON.stringify({ type: tab.type, name: tab.name, dirty: this.isDirty(tab),
          ...(tab.type === 'layout' ? { recoveryId: tab.recoveryId, activePageId: tab.activePageId, savedContent: '' } : {}),
          ...(tab.identity ? { identity: tab.identity } : {}), ...(tab.cloudDraft ? { cloudDraft: tab.cloudDraft } : {}) });
        if (tab.type === 'model') {
          const state = tab.app.document.doc.state, images = modelArchiveImages(state, tab.app.document.images);
          return { key: tab.id, state, metadata, encode: this.timedEncode(() => encodeModelSnapshot(state, images)) };
        }
        const state = tab.doc.state;
        return { key: tab.id, state, metadata, encode: this.timedEncode(() => encodeLayoutSnapshot(state)) };
      }) });
      return;
    }
    try {
      const fragments = this._tabs.map((tab) => this.refreshFragment(tab));
      for (const id of [...this.refreshFragments.keys()]) {
        if (!this._tabs.some((tab) => tab.id === id)) this.refreshFragments.delete(id);
      }
      // Unchanged tabs keep their fragment string, so these comparisons are by reference.
      const parts = fragments.map((fragment) => fragment.json);
      const activeIndex = this._tabs.indexOf(this.active);
      const sameParts = (other: readonly string[]): boolean =>
        other.length === parts.length && other.every((part, index) => part === parts[index]);
      const written = this.refreshWritten;
      if (written && written.activeIndex === activeIndex && sameParts(written.parts)) return;
      if (this.refreshRejected && sameParts(this.refreshRejected.parts)) return;
      const last = this.lastRefreshSnapshot;
      const text = last && last.activeIndex === activeIndex && sameParts(last.parts)
        ? last.text
        : `{"version":2,"activeIndex":${activeIndex},"tabs":[${parts.join(',')}]}`;
      this.lastRefreshSnapshot = { parts, activeIndex, text };
      try {
        this.refreshStorage.setItem(REFRESH_STORAGE_KEY, text);
      } catch {
        // Storage quota or privacy settings must not interrupt editing.
        this.refreshRejected = { parts };
        return;
      }
      this.refreshWritten = { parts, activeIndex };
      this.refreshRejected = null;
      this.dropRefreshImages(fragments);
    } catch {
      // Serialization or storage failures must not interrupt editing.
    }
  }

  /** Await all requested binary checkpoints (tests and explicit durability checks). */
  async settledNativeRecovery(): Promise<void> { await this.nativeWriter?.settled(); }

  /** The tab's serialized snapshot entry, rebuilt only when one of its inputs changed. */
  private refreshFragment(tab: DocumentTab): RefreshFragment {
    const state = tab.type === 'model' ? tab.app.document.doc.state : tab.doc.state;
    const images = tab.type === 'model' ? this.persistRefreshImages(tab).images : undefined;
    const imagesKey = images ? JSON.stringify(images) : '';
    const activePageId = tab.type === 'layout' ? tab.activePageId : 0;
    const cached = this.refreshFragments.get(tab.id);
    if (cached && cached.state === state && cached.name === tab.name && cached.savedContent === tab.savedContent &&
      cached.activePageId === activePageId && cached.identity === tab.identity &&
      cached.hasDraft === !!tab.cloudDraft && cached.projectId === tab.cloudDraft?.projectId &&
      cached.folderId === tab.cloudDraft?.folderId && cached.draftKey === tab.cloudDraft?.key &&
      cached.imagesKey === imagesKey) return cached;
    const entry: RefreshLayoutTab | RefreshModelTab = tab.type === 'layout' ? {
      type: 'layout', name: tab.name, recoveryId: tab.recoveryId,
      content: layoutContentJson(tab.doc), savedContent: tab.savedContent,
      activePageId: tab.activePageId,
      ...(tab.cloudDraft ? { cloudDraft: tab.cloudDraft } : {}),
      ...(tab.identity ? { identity: tab.identity } : {}),
    } : {
      type: 'model', name: tab.name,
      content: modelSessionContentJson(tab.app.document.doc),
      dirty: this.isDirty(tab),
      savedContent: tab.savedContent,
      ...(images ? { images } : {}),
      ...(tab.cloudDraft ? { cloudDraft: tab.cloudDraft } : {}),
      ...(tab.identity ? { identity: tab.identity } : {}),
    };
    const fragment: RefreshFragment = {
      state, name: tab.name, savedContent: tab.savedContent, activePageId, identity: tab.identity,
      projectId: tab.cloudDraft?.projectId, folderId: tab.cloudDraft?.folderId, hasDraft: !!tab.cloudDraft,
      draftKey: tab.cloudDraft?.key,
      images, imagesKey, json: JSON.stringify(entry),
    };
    this.refreshFragments.set(tab.id, fragment);
    return fragment;
  }

  /**
   * Keep the bytes of a model tab's image assets for refresh. Each image is written
   * once; one the store refuses is left out, and its material shows its color after a refresh.
   */
  private persistRefreshImages(tab: ModelTab): { images?: Record<string, string> } {
    const assets = tab.app.document.doc.state.images;
    const images: Record<string, string> = {};
    for (const [id, entry] of tab.app.document.images.entries()) {
      const sha256 = assets.get(id)?.sha256;
      if (!sha256 || this.refreshImagesTooLarge.has(sha256)) continue;
      if (!this.refreshImages.has(sha256)) {
        if (!this.refreshImageStore) continue;
        try {
          this.refreshImageStore.put(sha256, entry.blob);
          this.refreshImages.add(sha256);
        } catch {
          this.refreshImagesTooLarge.add(sha256);
          continue;
        }
      }
      images[String(id)] = sha256;
    }
    return Object.keys(images).length ? { images } : {};
  }

  /** Register the refresh-kept bytes of a restored model's image assets. */
  private restoreRefreshImages(state: DocumentState, images: unknown, store: ImageStore): void {
    if (!images || typeof images !== 'object') return;
    for (const [id, sha256] of Object.entries(images as Record<string, unknown>)) {
      const asset = state.images.get(Number(id) as ImageId);
      if (!asset || typeof sha256 !== 'string' || asset.sha256 !== sha256) continue;
      try {
        const image = this.refreshImageStore?.get(sha256);
        if (!image) continue;
        store.register(asset, image.bytes, image.mime);
        this.refreshImages.add(sha256);
      } catch {
        // A damaged image entry leaves that material with its color.
      }
    }
  }

  /** Remove kept image bytes that no open tab uses any more. */
  private dropRefreshImages(fragments: readonly RefreshFragment[]): void {
    if (!this.refreshImageStore) return;
    const used = new Set(fragments.flatMap((fragment) => Object.values(fragment.images ?? {})));
    for (const sha256 of [...this.refreshImages]) {
      if (used.has(sha256)) continue;
      this.refreshImageStore.delete(sha256);
      this.refreshImages.delete(sha256);
    }
  }

  /** Notify subscribers now; persistence for refresh is coalesced and runs later. */
  private emit(): void {
    this._revision++;
    this.scheduleRefreshPersistence();
    for (const fn of this.listeners) fn();
  }
}
