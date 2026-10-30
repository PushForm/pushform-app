// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { strFromU8, strToU8, zipSync, type Zippable } from 'fflate';
import type { ImageId } from '@pushform/core';
import { FORMAT_VERSION, type Document, type DocumentState, type ImageBlob } from '@pushform/model';
import { hydrateModelState, modelSessionJson } from './modelSession';
import { readNativeArchive } from './nativeArchive';

const MANIFEST = 'model.json';
const FORMAT = 'pushform-model';
/** Image bytes are stored beside the manifest as `images/<asset id>.<ext>`. */
const IMAGE_ENTRY = /^images\/(\d+)\.[a-z0-9]+$/;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
};

/** Where `encodeModelDocument` finds the bytes of the document's image assets (`DocumentHost.images`). */
export interface ModelImageSource { get(id: ImageId): ImageBlob | undefined }
/** One stored image entry of the archive, captured from the image source when a save starts. */
export interface ModelArchiveImage { id: ImageId; blob: ImageBlob }
export interface DecodedModelFile {
  state: DocumentState;
  /** Stored bytes by asset id; assets whose bytes the file lacks are absent. */
  images: Map<ImageId, ImageBlob>;
}
type ModelMigration = (state: unknown) => unknown;

/** Add a pure state migration here for each released .pf schema version. */
const migrations: Partial<Record<number, ModelMigration>> = {};

function migrateModelState(version: unknown, state: unknown): unknown {
  if (!Number.isSafeInteger(version) || (version as number) < 1 ||
      (version as number) > FORMAT_VERSION)
    throw new Error(`Unsupported model version: ${String(version)}`);
  let current = version as number;
  let migrated = state;
  while (current < FORMAT_VERSION) {
    const migration = migrations[current];
    if (!migration) throw new Error(`Unsupported model version: ${current}`);
    migrated = migration(migrated);
    current++;
  }
  return migrated;
}

/** Stable model content used for saved-state comparison and .pf storage. */
export function modelJson(state: DocumentState): string {
  return `{"format":"${FORMAT}","version":${FORMAT_VERSION},"state":${modelSessionJson(state)}}`;
}

/**
 * The image entries a save stores: every asset of `state` whose bytes `images` holds. Capture this
 * with the manifest text before any asynchronous work so the archive matches one snapshot.
 */
export function modelArchiveImages(state: DocumentState, images?: ModelImageSource | null): ModelArchiveImage[] {
  const entries: ModelArchiveImage[] = [];
  for (const asset of state.images.values()) {
    const blob = images?.get(asset.id);
    if (blob) entries.push({ id: asset.id, blob });
  }
  return entries;
}

/** Zip an already serialized manifest (`modelJson`) with its image entries. CPU-bound; see `encodeModelArchive`. */
export function encodeModelArchiveSync(content: string, images: readonly ModelArchiveImage[]): Uint8Array {
  const files: Zippable = { [MANIFEST]: strToU8(content) };
  // Image formats are already compressed.
  for (const { id, blob } of images) files[`images/${id}.${IMAGE_EXTENSIONS[blob.mime] ?? 'bin'}`] = [blob.bytes, { level: 0 }];
  return zipSync(files, { level: 6 });
}

/**
 * The .pf archive: `model.json` plus the bytes of every image asset `images` holds. Without
 * `images`, or for an asset whose bytes are not loaded, only its descriptor is written.
 */
export function encodeModelDocument(doc: Document, images?: ModelImageSource | null): Uint8Array {
  return encodeModelArchiveSync(modelJson(doc.state), modelArchiveImages(doc.state, images));
}

export function decodeModelDocument(bytes: Uint8Array): DocumentState {
  return decodeModelFile(bytes).state;
}

/**
 * Parse and migrate a `model.json` manifest into model state. The manifest is parsed once; the
 * migrated plain object is hydrated directly rather than re-serialized.
 */
export function parseModelManifest(json: string): DocumentState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Model document has invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid model document');
  const file = parsed as { format?: unknown; version?: unknown; state?: unknown };
  if (file.format !== FORMAT) throw new Error('Not a PushForm model document');
  const migrated = migrateModelState(file.version, file.state);
  if (migrated && typeof migrated === 'object' && 'meta' in migrated) {
    const meta = (migrated as { meta?: unknown }).meta;
    if (meta && typeof meta === 'object' && 'formatVersion' in meta &&
        (meta as { formatVersion: unknown }).formatVersion !== FORMAT_VERSION)
      throw new Error('Model document version does not match its manifest');
  }
  try {
    return hydrateModelState(migrated);
  } catch {
    throw new Error('Model document has invalid state');
  }
}

/**
 * State and stored image bytes of a .pf archive. Files saved before images were stored have none.
 * Only the manifest and image entries are inflated, within `nativeArchive` bounds.
 */
export function decodeModelFile(bytes: Uint8Array): DecodedModelFile {
  const files = readNativeArchive(bytes, { extension: '.pf', supported: name => name === MANIFEST || IMAGE_ENTRY.test(name) });
  const manifest = files[MANIFEST];
  if (!manifest) throw new Error('Model document is missing model.json');
  const state = parseModelManifest(strFromU8(manifest));
  const images = new Map<ImageId, ImageBlob>();
  for (const [name, data] of Object.entries(files)) {
    const match = IMAGE_ENTRY.exec(name);
    const asset = match ? state.images.get(Number(match[1]) as ImageId) : undefined;
    // Stored entries can be views into the archive; keep only the image.
    if (asset) images.set(asset.id, { bytes: data.slice(), mime: asset.mime });
  }
  return { state, images };
}
