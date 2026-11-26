// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError, MATERIAL_ASSET_LIMITS, materialAppearanceSchema, type MaterialAppearance, type MaterialReadResult, type materialReadSchema, type materialStageSchema, type MaterialStageResult } from '@pushform/extension-protocol';
import { imageSizeFromHeader } from '@pushform/model';
import type { DocumentHost } from '@pushform/commands';
import type { z } from 'zod';

export interface StagedMaterialAppearance { readonly appearance: MaterialAppearance; readonly bytes: Uint8Array }

/** A rebound descriptor must still describe the complete, owned raster bytes. */
export function validateStagedAppearance(value: StagedMaterialAppearance): void {
  const image = value.appearance.texture?.image;
  if (value.bytes.byteLength !== (image?.byteLength ?? 0)) fail('The appearance image byte length does not match its description.');
  if (image) validateImage(value.bytes, image);
}
type Upload = StagedMaterialAppearance & { document: string; revision: number; received: number; complete: boolean; expires: number };
const fail = (message: string): never => { throw new ExtensionError('validation.failed', message); };

/** Read only a referenced material image, never another document's runtime image or an arbitrary URL. */
export function readMaterialAppearance(host: DocumentHost, input: z.infer<typeof materialReadSchema>): MaterialReadResult {
  if (host.doc.version !== input.expectedRevision) throw new ExtensionError('revision.stale', 'The material changed; read it again at the current model revision.');
  const state = host.doc.state, material = state.materials.get(input.materialId as never);
  if (!material) return fail('This material no longer exists.');
  if (state.nativeMaterialUnknownFields?.has(material.id)) throw new ExtensionError('extension.unsupported', 'This appearance contains fields that need a compatible reader. It cannot be reduced during transfer.');
  let bytes: Uint8Array = new Uint8Array(), texture: MaterialAppearance['texture'] = null;
  if (material.texture) {
    const t = material.texture, image = state.images.get(t.imageId), blob = host.images.get(t.imageId);
    if (!image || !blob) throw new ExtensionError('unavailable', 'The complete material image is unavailable. No plain-color replacement was produced.');
    bytes = blob.bytes;
    texture = { widthM: t.widthM, heightM: t.heightM, colorize: t.colorize,
      ...(t.colorizeType ? { colorizeType: t.colorizeType } : {}), ...(t.grain ? { grain: t.grain } : {}),
      image: { name: t.imageName ?? image.name, mime: image.mime as NonNullable<MaterialAppearance['texture']>['image']['mime'], width: image.width, height: image.height, byteLength: bytes.byteLength } };
  }
  const parsed = materialAppearanceSchema.safeParse({ name: material.name, color: [...material.color], opacity: material.alpha, texture });
  if (!parsed.success) throw new ExtensionError('extension.unsupported', 'This material appearance exceeds the portable raster format or resource limits.');
  if (input.offset > bytes.byteLength) return fail('Image offset is beyond the material image.');
  const end = Math.min(bytes.byteLength, input.offset + input.limit);
  return { revision: host.doc.version, materialId: material.id, appearance: parsed.data, bytes: bytes.slice(input.offset, end), next: end < bytes.byteLength ? end : null };
}

/** Temporary session-owned bytes; no document ids, model mutations or durable handles are created here. */
export class MaterialAppearanceStaging {
  private readonly uploads = new Map<string, Upload>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly now = () => Date.now(), private readonly retainedBytes = () => 0) {}
  stage(document: string, revision: number, input: z.infer<typeof materialStageSchema>): MaterialStageResult {
    this.reap();
    if (input.discard) {
      if (!input.upload || input.appearance || input.bytes?.byteLength) return fail('Discard needs only an owned upload handle.');
      this.owned(input.upload, document); this.uploads.delete(input.upload); this.reap();
      return { upload: input.upload, received: 0, complete: false };
    }
    if (revision !== input.expectedRevision) throw new ExtensionError('revision.stale', 'The model changed during appearance staging.');
    let upload = input.upload, current: Upload;
    if (upload) {
      current = this.owned(upload, document);
      if (current.revision !== revision) throw new ExtensionError('revision.stale', 'The model changed after this appearance upload started.');
      if (input.appearance) return fail('An existing upload cannot change its appearance description.');
    } else {
      if (!input.appearance || input.offset !== 0) return fail('A new upload needs an appearance and starts at offset zero.');
      const size = input.appearance.texture?.image.byteLength ?? 0;
      const reserved = [...this.uploads.values()].reduce((sum, item) => sum + item.bytes.byteLength, 0);
      if (this.uploads.size >= MATERIAL_ASSET_LIMITS.uploads || reserved + this.retainedBytes() + size > MATERIAL_ASSET_LIMITS.sessionBytes)
        throw new ExtensionError('limit.exceeded', 'The session appearance staging quota is full. Finish or discard another upload.');
      upload = `material_${crypto.randomUUID().replaceAll('-', '')}`;
      current = { appearance: structuredClone(input.appearance), bytes: new Uint8Array(size), document, revision, received: 0, complete: false, expires: this.now() + MATERIAL_ASSET_LIMITS.lifetimeMs };
      this.uploads.set(upload, current);
    }
    const bytes = input.bytes ?? new Uint8Array();
    if (current.complete || input.offset !== current.received || current.received + bytes.byteLength > current.bytes.byteLength) {
      // A bad chunk does not consume or corrupt the completed prefix; the caller can retry the correct offset.
      if (!input.upload) this.uploads.delete(upload);
      this.reap();
      return fail('Upload chunks must be sequential and fit the declared image size.');
    }
    current.bytes.set(bytes, current.received); current.received += bytes.byteLength;
    if (current.received === current.bytes.byteLength) {
      try { if (current.appearance.texture) validateImage(current.bytes, current.appearance.texture.image); }
      catch (error) { this.uploads.delete(upload); this.reap(); throw error; }
      current.complete = true;
    }
    this.reap();
    return { upload, received: current.received, complete: current.complete };
  }
  resolve(document: string, revision: number, operations: readonly { op: string; [key: string]: unknown }[]): ReadonlyMap<string, StagedMaterialAppearance> {
    this.reap(); const result = new Map<string, StagedMaterialAppearance>();
    for (const operation of operations) if (operation.op === 'add_material_appearance' || operation.op === 'set_material_appearance') {
      if (typeof operation.asset !== 'string') return fail('The operation needs a completed appearance upload.');
      const upload = this.owned(operation.asset, document);
      if (!upload.complete) return fail('The appearance upload is incomplete.');
      if (upload.revision !== revision) throw new ExtensionError('revision.stale', 'The appearance was staged at a different model revision.');
      result.set(operation.asset, upload);
    }
    return result;
  }
  consume(assets: ReadonlyMap<string, StagedMaterialAppearance>): void { for (const key of assets.keys()) this.uploads.delete(key); this.reap(); }
  closed(document: string): void { for (const [key, value] of this.uploads) if (value.document === document) this.uploads.delete(key); this.reap(); }
  dispose(): void { this.uploads.clear(); if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private owned(handle: string, document: string): Upload {
    const upload = this.uploads.get(handle);
    if (!upload || upload.document !== document) return fail('This appearance upload is unavailable, expired or belongs to another document/session.');
    return upload;
  }
  private reap(): void {
    if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
    const now = this.now();
    for (const [key, value] of this.uploads) if (value.expires <= now) this.uploads.delete(key);
    if (this.uploads.size) this.timer = setTimeout(() => this.reap(), Math.max(1, Math.min(...[...this.uploads.values()].map(value => value.expires)) - now));
  }
}

function validateImage(bytes: Uint8Array, image: NonNullable<MaterialAppearance['texture']>['image']): void {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  const mime = starts(137, 80, 78, 71, 13, 10, 26, 10) ? 'image/png' : starts(255, 216, 255) ? 'image/jpeg'
    : starts(71, 73, 70, 56) ? 'image/gif' : starts(66, 77) ? 'image/bmp'
    : starts(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80 ? 'image/webp' : null;
  let size = imageSizeFromHeader(bytes);
  if (mime === 'image/webp' && bytes.length >= 30) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === 'VP8X') size = { width: 1 + (bytes[24]! | bytes[25]! << 8 | bytes[26]! << 16), height: 1 + (bytes[27]! | bytes[28]! << 8 | bytes[29]! << 16) };
    if (kind === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) size = { width: view.getUint16(26, true) & 16383, height: view.getUint16(28, true) & 16383 };
    if (kind === 'VP8L' && bytes[20] === 47) { const bits = view.getUint32(21, true); size = { width: (bits & 16383) + 1, height: (bits >>> 14 & 16383) + 1 }; }
  }
  if (mime !== image.mime || !size || size.width !== image.width || size.height !== image.height) fail('The raster image signature or pixel dimensions do not match its appearance description.');
}
