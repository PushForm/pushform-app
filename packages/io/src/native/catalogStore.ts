// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DocumentState } from '@pushform/model';
import type { ImageId } from '@pushform/core';
import type { NativeCatalogEntry } from './catalog';
import type { NativeImageRecord } from './imageAsset';
import { NativeChunkError } from './chunks';

export type NativeModelCatalogs = Pick<DocumentState, 'materials' | 'tags' | 'tagFolders' | 'styles' | 'scenes' | 'images'>;
type KnownEntry = Exclude<NativeCatalogEntry, { kind: 'unknown' }>;
type Kind = KnownEntry['kind'];
type Extras<K extends Kind> = Omit<Extract<KnownEntry, { kind: K }>, 'kind' | 'value'>;
type Sidecars = { [K in Kind]: Map<number, Extras<K>> };
type ImageExtras = Omit<NativeImageRecord, 'asset'>;

function containsUnknown(value: unknown): boolean {
  if (value instanceof Map) return value.size > 0;
  return typeof value === 'object' && value !== null && Object.values(value).some(containsUnknown);
}
function insert<K, V>(map: Map<K, V>, id: K, value: V): void {
  if (map.has(id)) throw new NativeChunkError('Duplicate native catalog ID');
  map.set(id, value);
}

/** Staging only: callers publish these Maps after complete document validation. */
export class NativeCatalogStore {
  readonly values: NativeModelCatalogs = {
    materials: new Map(), tags: new Map(), tagFolders: new Map(), styles: new Map(), scenes: new Map(), images: new Map(),
  };
  readonly unknown: Extract<NativeCatalogEntry, { kind: 'unknown' }>[] = [];
  private readonly extras: Sidecars = { material: new Map(), tag: new Map(), tagFolder: new Map(), style: new Map(), scene: new Map(), image: new Map() };
  private readonly images = new Map<ImageId, ImageExtras>();

  /** Takes ownership of decoded records; known values are retained only in their destination Map. */
  add(entry: NativeCatalogEntry): void {
    if (entry.kind === 'unknown') { this.unknown.push(entry); return; }
    switch (entry.kind) {
      case 'material': insert(this.values.materials, entry.value.id, entry.value); this.remember('material', entry.value.id, entry); break;
      case 'tag': insert(this.values.tags, entry.value.id, entry.value); this.remember('tag', entry.value.id, entry); break;
      case 'tagFolder': insert(this.values.tagFolders, entry.value.id, entry.value); this.remember('tagFolder', entry.value.id, entry); break;
      case 'style': insert(this.values.styles, entry.value.id, entry.value); this.remember('style', entry.value.id, entry); break;
      case 'scene': insert(this.values.scenes, entry.value.id, entry.value); this.remember('scene', entry.value.id, entry); break;
      case 'image': {
        const { asset, ...extra } = entry.value;
        insert(this.values.images, asset.id, asset); this.remember('image', asset.id, entry);
        if (extra.payload || extra.unknownFields.length) this.images.set(asset.id, extra);
        break;
      }
    }
  }

  private remember<K extends Kind>(kind: K, id: number, entry: Extras<K>): void {
    // Explicit extraction is important: do not accidentally retain entry.value in the sidecar.
    const extras: { required?: boolean; envelopeUnknown?: Uint8Array[]; extensions?: unknown } = {};
    if (entry.required === false) extras.required = false;
    if (entry.envelopeUnknown?.length) extras.envelopeUnknown = entry.envelopeUnknown;
    if ('extensions' in entry && containsUnknown(entry.extensions)) extras.extensions = entry.extensions;
    if (Object.keys(extras).length) this.extras[kind].set(id, extras as Extras<K>);
  }

  /** Transfer byte-only tag sidecars to editable state without retaining this staging store. */
  tagUnknownFields(): DocumentState['nativeTagUnknownFields'] {
    return this.extras.tag.size || this.extras.tagFolder.size ? { tags: this.extras.tag, folders: this.extras.tagFolder } : undefined;
  }

  materialUnknownFields(): DocumentState['nativeMaterialUnknownFields'] {
    return this.extras.material.size ? this.extras.material : undefined;
  }

  /** Keep only unknown image metadata, not file-local payload references or image bytes. */
  imageUnknownFields(): DocumentState['nativeImageUnknownFields'] {
    const fields: NonNullable<DocumentState['nativeImageUnknownFields']> = new Map();
    for (const id of this.values.images.keys()) {
      const extra = this.extras.image.get(id), unknownFields = this.images.get(id)?.unknownFields ?? [];
      if (extra || unknownFields.length) fields.set(id, { ...extra, unknownFields });
    }
    return fields.size ? fields : undefined;
  }

  sceneUnknownFields(): DocumentState['nativeSceneUnknownFields'] {
    return this.extras.scene.size ? this.extras.scene : undefined;
  }

  /** Watermark fields live on their editable owner so array moves/deletions cannot misattach them. */
  styleUnknownFields(): DocumentState['nativeStyleUnknownFields'] {
    const result: NonNullable<DocumentState['nativeStyleUnknownFields']> = new Map();
    for (const [id, extra] of this.extras.style) {
      const extensions = new Map(extra.extensions);
      for (const [path, fields] of extensions) if (path.startsWith('watermarks.')) {
        const watermark = this.values.styles.get(id as DocumentState['activeStyleId'])!.watermarks[Number(path.slice(11))];
        if (!watermark) throw new NativeChunkError('Missing native watermark owner');
        watermark.nativeUnknownFields = fields; extensions.delete(path);
      }
      const { extensions: _extensions, ...envelope } = extra;
      if (extensions.size || Object.keys(envelope).length) result.set(id, { ...envelope, ...(extensions.size ? { extensions } : {}) });
    }
    return result.size ? result : undefined;
  }

  imageRecord(id: ImageId): NativeImageRecord {
    const asset = this.values.images.get(id);
    if (!asset) throw new NativeChunkError('Missing native image asset');
    return { asset, ...(this.images.get(id) ?? { unknownFields: [] }) };
  }

  /** Traverse a captured revision. Deleted owners are omitted; IDs must never be reused.
   * Asset payload IDs are file-local: the writer MUST provide freshly assigned records.
   */
  *entries(values: NativeModelCatalogs, imageRecord: (id: ImageId) => NativeImageRecord): Generator<NativeCatalogEntry> {
    for (const value of values.materials.values()) yield { kind: 'material', value, ...this.extras.material.get(value.id) };
    for (const value of values.tags.values()) yield { kind: 'tag', value, ...this.extras.tag.get(value.id) };
    for (const value of values.tagFolders.values()) yield { kind: 'tagFolder', value, ...this.extras.tagFolder.get(value.id) };
    for (const value of values.styles.values()) yield { kind: 'style', value, ...this.extras.style.get(value.id) };
    for (const value of values.scenes.values()) yield { kind: 'scene', value, ...this.extras.scene.get(value.id) };
    for (const asset of values.images.values()) {
      const record = imageRecord(asset.id);
      if (record.asset.id !== asset.id) throw new NativeChunkError('Mismatched native image asset');
      yield { kind: 'image', value: { ...record, asset, unknownFields: this.images.get(asset.id)?.unknownFields ?? record.unknownFields }, ...this.extras.image.get(asset.id) };
    }
    yield* this.unknown;
  }
}

export async function readNativeCatalogStore(entries: Iterable<NativeCatalogEntry> | AsyncIterable<NativeCatalogEntry>): Promise<NativeCatalogStore> {
  const result = new NativeCatalogStore();
  for await (const entry of entries) result.add(entry);
  return result;
}
