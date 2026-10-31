// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type {
  DefId,
  Guid,
  ImageId,
  MaterialId,
  SceneId,
  StyleId,
  TagFolderId,
  TagId,
  UnitSettings,
} from '@pushform/core';
import type { ModelAttribution } from '../attribution';
import type { ComponentDefinition } from './definition';
import type { FogSettings, ImageAsset, Material, Scene, ShadowSettings, Style, Tag, TagFolder } from './attrs';
import type { DimensionStyle } from './misc';

export const FORMAT_VERSION = 1;

export interface DocumentMeta {
  /** Original source licenses and notices retained through edits, saves and exports. */
  attributions?: ModelAttribution[];
  guid: Guid;
  formatVersion: number;
  /** Next persistent id; monotonically increasing, never reused. */
  nextId: number;
  units: UnitSettings;
  /** Model Info › Dimensions: the style new dimensions get; absent = `DEFAULT_DIMENSION_STYLE`. */
  dimensions?: DimensionStyle | undefined;
}

/** Opaque envelope and nested record fields attached to a persistent catalog owner. */
export interface NativeCatalogUnknownFields {
  required?: boolean;
  envelopeUnknown?: Uint8Array[];
  extensions?: Map<string, Uint8Array[]>;
}

/** Persistent immer-managed document state; selection, camera and tool state live outside. */
export interface DocumentState {
  nativeStyleUnknownFields?: Map<number, NativeCatalogUnknownFields>;
  nativeSceneUnknownFields?: Map<number, {
    required?: boolean; envelopeUnknown?: Uint8Array[];
    extensions?: { records: Map<string, Uint8Array[]>; camera: Map<string, Uint8Array[]>; shadows?: Map<string, Uint8Array[]>; fog?: Map<string, Uint8Array[]> };
  }>;
  /** Image metadata only: encoded payload chunk IDs are file-local and never retained here. */
  nativeImageUnknownFields?: Map<number, { required?: boolean; envelopeUnknown?: Uint8Array[]; unknownFields: Uint8Array[] }>;
  nativeMaterialUnknownFields?: Map<number, NativeCatalogUnknownFields>;
  /** Byte-only native catalog sidecars keyed by persistent owner ID. */
  nativeTagUnknownFields?: { tags: Map<number, NativeCatalogUnknownFields>; folders: Map<number, NativeCatalogUnknownFields> };
  /** Unknown fields scoped to native settings records; opaque immutable bytes, no known-value copies. */
  nativeSettingsUnknownFields?: {
    records: Map<string, Uint8Array[]>;
    meta: Map<string, Uint8Array[]>;
    shadows: Map<string, Uint8Array[]>;
    fog?: Map<string, Uint8Array[]>;
  };
  /** Owned opaque Protobuf root fields; immutable bytes retained through edits and native saves. */
  nativeRootUnknownFields?: Uint8Array[];
  meta: DocumentMeta;
  definitions: Map<DefId, ComponentDefinition>;
  rootDefinitionId: DefId;
  tags: Map<TagId, Tag>;
  tagFolders: Map<TagFolderId, TagFolder>;
  /** The "Untagged" tag every new entity gets. */
  defaultTagId: TagId;
  materials: Map<MaterialId, Material>;
  /** The default front/back material used when a face has none. */
  defaultMaterialId: MaterialId;
  images: Map<ImageId, ImageAsset>;
  styles: Map<StyleId, Style>;
  activeStyleId: StyleId;
  scenes: Map<SceneId, Scene>;
  sceneOrder: SceneId[];
  shadows: ShadowSettings;
  /** Fog settings; absent in documents saved before fog existed (treated as `DEFAULT_FOG`). */
  fog?: FogSettings | undefined;
}
