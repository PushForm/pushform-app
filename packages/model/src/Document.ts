// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { applyPatches, createDraft, enableMapSet, enablePatches, finishDraft, freeze, type Draft, type Patch, type PatchListener, produce } from 'immer';
import {
  DEFAULT_UNITS,
  Emitter,
  newGuid,
  type DefId,
  type Id,
  type MaterialId,
  type StyleId,
  type TagId,
} from '@pushform/core';
import { createEntityContainer, DEFAULT_AXES, DEFAULT_BEHAVIORS, type ComponentDefinition } from './entities/definition';
import { reconcileNativeDimensionFields } from './nativeDimensionFields';
import { reconcileNativeInstanceFields } from './nativeInstanceFields';
import { reconcileNativeAttributeFields } from './nativeAttributeFields';
import { reconcilePackedVertexIndexes } from './sketch/reconcileVertexIndex';
import { reconcileNativeStyleFields } from './nativeStyleFields';
import { reconcileNativeSceneFields } from './nativeSceneFields';
import { reconcileNativeImageFields } from './nativeImageFields';
import { reconcileNativeMaterialFields } from './nativeMaterialFields';
import { reconcileNativeTagFields } from './nativeTagFields';
import { reconcileNativeSettingsFields } from './nativeSettingsFields';
import { FORMAT_VERSION, type DocumentState } from './entities/document';
import type { FogSettings, Material, SceneFlags, ShadowSettings, Style, Tag } from './entities/attrs';

let immerConfigured = false;
/** Enables immer Map/Set and patch support exactly once (safe to call repeatedly). */
export function configureImmer(): void {
  if (immerConfigured) return;
  enableMapSet();
  enablePatches();
  immerConfigured = true;
}
configureImmer();

export type { Draft, Patch };
export type DocumentDraft = Draft<DocumentState>;

export interface Transaction<T> {
  label: string;
  value: T;
  /** Empty for a nested transaction: its changes are merged into the outermost one. */
  patches: Patch[];
  inversePatches: Patch[];
  nested: boolean;
}

export type ChangeSource = 'transact' | 'undo' | 'redo' | 'load';
export interface ChangeEvent {
  label: string;
  patches: Patch[];
  inversePatches: Patch[];
  source: ChangeSource;
}
export type DocumentEvents = { change: ChangeEvent };

/** Allocate a persistent id from a draft's `meta.nextId` (must be called inside a transaction). */
export function allocId<T extends number = Id>(draft: { meta: { nextId: number } }): T {
  const v = draft.meta.nextId;
  if (v > 0xffff_ffff) throw new Error('Document id space exhausted');
  draft.meta.nextId = v + 1;
  return v as T;
}

/** core `IdAllocator`-compatible allocator writing through to a draft's `meta.nextId`. */
export class DraftIdAllocator {
  constructor(private readonly draft: { meta: { nextId: number } }) {}
  alloc<T extends number = Id>(): T {
    return allocId<T>(this.draft);
  }
  reserve(count: number): number {
    const first = this.draft.meta.nextId;
    this.draft.meta.nextId += count;
    return first;
  }
  get current(): number {
    return this.draft.meta.nextId;
  }
}

/** Minimum state shape the transactional machinery needs: the persistent id allocator. */
export interface DocStateMeta {
  meta: { nextId: number };
}

/** Structural document API the undo stack records against (implemented by `TransactionalDocument`). */
export interface TransactionalDocumentLike<S> {
  transact<T>(label: string, fn: (draft: Draft<S>) => T): Transaction<T>;
  applyPatches(patches: Patch[], inversePatches: Patch[], source: ChangeSource, label: string): void;
}

/**
 * A typed immutable state plus transactions that yield immer patches: the base for every document
 * type (model, layout). Every mutation goes through `transact`; nested calls merge into the
 * outermost transaction. Emits `change` for every applied transaction, undo, redo and load.
 */
export class TransactionalDocument<S extends DocStateMeta> {
  private _state: S;
  private draft: Draft<S> | null = null;
  private _version = 0;
  readonly events = new Emitter<DocumentEvents>();

  constructor(state: S) {
    this._state = freeze(state, true);
  }
  /** When true, undo never rolls `meta.nextId` back (ids are never reused). The model document enables this. */
  protected get monotonicIds(): boolean {
    return false;
  }

  get state(): S {
    return this._state;
  }
  get inTransaction(): boolean {
    return this.draft !== null;
  }
  /**
   * Monotonic change counter: transactions that produced patches, undos, redos and loads.
   * Runtime-only for now (viewport snapshot staleness); persisted with the file formats in M4.
   */
  get version(): number {
    return this._version;
  }

  /**
   * Run `fn` against a draft. On success the new state is committed, `change` is emitted and the
   * patches are returned. Throwing discards the draft (no partial state). Nested calls run on the
   * outer draft and return no patches.
   */
  transact<T>(label: string, fn: (draft: Draft<S>) => T): Transaction<T> {
    if (this.draft) {
      return { label, value: fn(this.draft), patches: [], inversePatches: [], nested: true };
    }
    const draft = createDraft(this._state) as Draft<S>;
    this.draft = draft;
    let value: T;
    try {
      value = fn(draft);
      this.prepareCommit(draft);
    } finally {
      this.draft = null;
    }
    let patches: Patch[] = [], inversePatches: Patch[] = [];
    // cast: immer's `D extends Draft<infer T>` instantiation is too deep for the state types
    const finish = finishDraft as (d: unknown, listener?: PatchListener) => unknown;
    let next = finish(draft, (p, ip) => {
      patches = p;
      inversePatches = ip;
    }) as S;
    const reconciled = this.reconcileCommit(next, patches);
    if (reconciled) {
      next = reconciled[0]; patches.push(...reconciled[1]);
      inversePatches = [...reconciled[2], ...inversePatches];
    }
    this._state = next;
    if (patches.length) {
      this._version++;
      this.events.emit('change', { label, patches, inversePatches, source: 'transact' });
    }
    return { label, value, patches, inversePatches, nested: false };
  }

  /** Reconcile persistent sidecars inside the same outer transaction and undo entry. */
  protected prepareCommit(_draft: Draft<S>): void { /* Default documents have no sidecars to reconcile. */ }

  /** Optional patch-directed reconciliation, before publication and within the same undo entry. */
  protected reconcileCommit(_state: S, _patches: Patch[]): [S, Patch[], Patch[]] | null { return null; }

  /** Allocate a persistent id inside the current transaction. */
  alloc<T extends number = Id>(): T {
    if (!this.draft) throw new Error('Document.alloc() requires an open transaction');
    return allocId<T>(this.draft);
  }

  /** Apply recorded patches (undo/redo). Not allowed inside a transaction. */
  applyPatches(patches: Patch[], inversePatches: Patch[], source: ChangeSource, label: string): void {
    if (this.draft) throw new Error('Cannot apply patches inside a transaction');
    // cast: immer's generic instantiation is too deep for the states' nested Maps
    const keepNextId = this._state.meta.nextId;
    let next = applyPatches(this._state as object, patches) as S;
    // Persistent ids are never reused: undo must not roll the allocator back, or entities created
    // afterwards would collide with ids that still live in the undo/redo history and caches.
    if (this.monotonicIds && next.meta.nextId < keepNextId) {
      next = produce(next as object, (d) => {
        (d as DocStateMeta).meta.nextId = keepNextId;
      }) as S;
    }
    this._state = next;
    this._version++;
    this.events.emit('change', { label, patches, inversePatches, source });
  }

  /** Replace the whole state (file load). Listeners rebuild from scratch on `source: 'load'`. */
  replaceState(state: S, label = 'load'): void {
    if (this.draft) throw new Error('Cannot replace state inside a transaction');
    this._state = freeze(state, true);
    this._version++;
    this.events.emit('change', { label, patches: [], inversePatches: [], source: 'load' });
  }
}

/**
 * The model document. Layout documents (`@pushform/layout`) build on the same
 * `TransactionalDocument` base with their own state root.
 */
export class Document extends TransactionalDocument<DocumentState> {
  protected override reconcileCommit(state: DocumentState, patches: Patch[]): [DocumentState, Patch[], Patch[]] | null {
    const spatial = reconcilePackedVertexIndexes(state, patches), base = spatial?.[0] ?? state;
    const instances = reconcileNativeInstanceFields(base, patches);
    const dimensions = reconcileNativeDimensionFields(instances?.[0] ?? base, patches);
    const attributes = reconcileNativeAttributeFields(dimensions?.[0] ?? instances?.[0] ?? base, patches);
    const changes = [spatial, instances, dimensions, attributes].filter((change): change is [DocumentState, Patch[], Patch[]] => change !== null);
    return changes.length ? [changes[changes.length - 1]![0], changes.flatMap(change => change[1]), changes.reverse().flatMap(change => change[2])] : null;
  }
  protected override prepareCommit(draft: Draft<DocumentState>): void {
    // Avoid recursively instantiating the full Immer graph at the persistence boundary.
    const state = draft as unknown as DocumentState;
    reconcileNativeSettingsFields(state); reconcileNativeTagFields(state); reconcileNativeMaterialFields(state); reconcileNativeImageFields(state);
    reconcileNativeSceneFields(state); reconcileNativeStyleFields(state);
  }
  protected override get monotonicIds(): boolean {
    return true;
  }
  constructor(state: DocumentState = createDocumentState()) {
    super(state);
  }

  get rootDefinition(): ComponentDefinition {
    return this._stateRootDefinition;
  }
  private get _stateRootDefinition(): ComponentDefinition {
    return this.state.definitions.get(this.state.rootDefinitionId)!;
  }
}

// ---------------------------------------------------------------------------------------------
// Defaults

export const DEFAULT_SHADOWS: ShadowSettings = {
  enabled: false,
  month: 11,
  day: 8,
  time: 13 * 60 + 30,
  utcOffsetHours: -7,
  latitude: 40.017,
  longitude: -105.283,
  northAngle: 0,
  light: 80,
  dark: 45,
  useSunForShading: true,
  onGround: true,
  onFaces: true,
  fromEdges: false,
};

export const DEFAULT_FOG: FogSettings = {
  enabled: false,
  near: 0,
  far: 100,
  useBackground: true,
  color: [0.8, 0.8, 0.8],
};

/** Every scene property is saved by default. */
export const DEFAULT_SCENE_FLAGS: SceneFlags = {
  useCamera: true,
  useHiddenGeometry: true,
  useHiddenObjects: true,
  useTags: true,
  useStyle: true,
  useShadows: true,
  useSectionPlanes: true,
  useAxes: true,
};

export function createDefaultStyle(id: StyleId): Style {
  return {
    id,
    name: 'Default',
    description: 'Shaded with textures, profiles on, white background with sky and ground.',
    edges: {
      edges: true,
      profiles: true,
      profileWidth: 2,
      depthCue: false,
      depthCueLevels: 4,
      extension: false,
      extensionLength: 3,
      endpoints: false,
      endpointLength: 7,
      jitter: false,
      backEdges: false,
      color: [0, 0, 0],
      colorMode: 'allSame',
    },
    faces: {
      mode: 'shadedWithTextures',
      frontColor: [1, 1, 1],
      backColor: [0.63, 0.67, 0.75],
      xrayOpacity: 0.3,
    },
    background: {
      color: [1, 1, 1],
      sky: true,
      skyColor: [0.78, 0.86, 0.96],
      ground: true,
      groundColor: [0.86, 0.84, 0.78],
      groundTransparency: 0.5,
      showGroundFromBelow: false,
    },
    modeling: {
      selected: [0.1, 0.4, 0.9],
      locked: [0.85, 0.1, 0.1],
      guides: [0.3, 0.3, 0.3],
      inactiveSection: [0.6, 0.6, 0.6],
      activeSection: [1, 0.55, 0.1],
      sectionFill: [0.35, 0.35, 0.35],
      sectionLine: [0.1, 0.1, 0.1],
      sectionLineWidth: 3,
      sectionFillEnabled: true,
      hiddenGeometry: false,
      guidesVisible: true,
      sectionPlanesVisible: true,
      sectionCutsVisible: true,
      modelAxesVisible: true,
    },
    watermarks: [],
  };
}

export function createDefaultMaterial(id: MaterialId): Material {
  return { id, name: 'Default', color: [1, 1, 1], alpha: 1, texture: null };
}

export function createDefaultTag(id: TagId): Tag {
  return { id, name: 'Untagged', visible: true, color: [0.3, 0.3, 0.3], dashes: null, folderId: null };
}

/** A fresh document: root definition, "Untagged" tag, default material and style, default units. */
export function createDocumentState(): DocumentState {
  let nextId = 1;
  const rootDefinitionId = nextId++ as DefId;
  const defaultTagId = nextId++ as TagId;
  const defaultMaterialId = nextId++ as MaterialId;
  const activeStyleId = nextId++ as StyleId;
  const root: ComponentDefinition = {
    id: rootDefinitionId,
    guid: newGuid(),
    name: 'Model',
    description: '',
    isGroup: false,
    axes: DEFAULT_AXES,
    behaviors: DEFAULT_BEHAVIORS,
    entities: createEntityContainer(),
    bounds: null,
  };
  return {
    meta: { guid: newGuid(), formatVersion: FORMAT_VERSION, nextId, units: { ...DEFAULT_UNITS } },
    definitions: new Map([[rootDefinitionId, root]]),
    rootDefinitionId,
    tags: new Map([[defaultTagId, createDefaultTag(defaultTagId)]]),
    tagFolders: new Map(),
    defaultTagId,
    materials: new Map([[defaultMaterialId, createDefaultMaterial(defaultMaterialId)]]),
    defaultMaterialId,
    images: new Map(),
    styles: new Map([[activeStyleId, createDefaultStyle(activeStyleId)]]),
    activeStyleId,
    scenes: new Map(),
    sceneOrder: [],
    shadows: DEFAULT_SHADOWS,
    fog: DEFAULT_FOG,
  };
}

export function createDocument(): Document {
  return new Document(createDocumentState());
}
