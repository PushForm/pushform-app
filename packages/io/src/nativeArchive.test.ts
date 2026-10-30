// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { createLayoutDocument } from '@pushform/layout';
import { createDocument } from '@pushform/model';
import { NATIVE_ARCHIVE_MAX_ENTRIES, NATIVE_ARCHIVE_MAX_EXPANDED_BYTES, NativeArchiveError, readNativeArchive } from './nativeArchive';
import { decodeModelFile, modelJson } from './modelFile';
import { decodeLayoutDocument, layoutJson } from './layoutFile';

/** A zip whose central directory claims `size` expanded bytes for `name` without holding them. */
function claimedSize(name: string, size: number): Uint8Array {
  const bytes = zipSync({ [name]: strToU8('{}') });
  // Central directory: scan back to the end record, then patch the single entry's uncompressed size.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const central = view.getUint32(end + 16, true);
  view.setUint32(central + 24, size, true);
  return bytes;
}

describe('native archive bounds', () => {
  it('inflates only supported entries and leaves the rest untouched', () => {
    const files = readNativeArchive(zipSync({ 'model.json': strToU8('{}'), 'junk.bin': strToU8('x'.repeat(1000)) }),
      { extension: '.pf', supported: name => name === 'model.json' });
    expect(Object.keys(files)).toEqual(['model.json']);
  });

  it('rejects archives with more entries than the bound before inflating anything', () => {
    const files: Zippable = {};
    for (let i = 0; i <= NATIVE_ARCHIVE_MAX_ENTRIES; i++) files[`images/${i}.png`] = [new Uint8Array(1), { level: 0 }];
    files['model.json'] = strToU8(modelJson(createDocument().state));
    const bytes = zipSync(files);
    expect(() => decodeModelFile(bytes)).toThrow(`Invalid .pf archive: more than ${NATIVE_ARCHIVE_MAX_ENTRIES} entries`);
    expect(() => decodeModelFile(bytes)).toThrow(NativeArchiveError);
  });

  it('rejects a manifest whose declared expanded size exceeds the bound', () => {
    expect(() => decodeModelFile(claimedSize('model.json', NATIVE_ARCHIVE_MAX_EXPANDED_BYTES + 1)))
      .toThrow('Invalid .pf archive: expands beyond 512 MiB');
    expect(() => decodeLayoutDocument(claimedSize('layout.json', NATIVE_ARCHIVE_MAX_EXPANDED_BYTES + 1)))
      .toThrow('Invalid .pfl archive: expands beyond 512 MiB');
    // Unsupported entries do not count toward the expanded bound, but still count as entries.
    const bytes = claimedSize('other.bin', NATIVE_ARCHIVE_MAX_EXPANDED_BYTES + 1);
    expect(() => decodeModelFile(bytes)).toThrow('Model document is missing model.json');
  });

  it('sums expanded sizes across supported entries', () => {
    const files: Zippable = { 'model.json': strToU8(modelJson(createDocument().state)) };
    const half = new Uint8Array(1024);
    files['images/1.png'] = [half, { level: 0 }]; files['images/2.png'] = [half, { level: 0 }];
    const bytes = zipSync(files);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    while (view.getUint32(end, true) !== 0x06054b50) end--;
    // Patch each image entry's declared uncompressed size to just over half the bound.
    let offset = view.getUint32(end + 16, true);
    for (let i = 0; i < 3; i++) {
      const nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
      const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      if (name.startsWith('images/')) view.setUint32(offset + 24, NATIVE_ARCHIVE_MAX_EXPANDED_BYTES / 2 + 1, true);
      offset += 46 + nameLength + extra + comment;
    }
    expect(() => decodeModelFile(bytes)).toThrow('expands beyond');
  });

  it('keeps reporting corrupt bytes as an invalid archive', () => {
    expect(() => decodeModelFile(new Uint8Array([1, 2, 3]))).toThrow('Invalid .pf archive');
    expect(() => decodeLayoutDocument(new Uint8Array(40))).toThrow('Invalid .pfl archive');
    expect(() => decodeLayoutDocument(zipSync({ 'layout.json': strToU8(layoutJson(createLayoutDocument().state)) }))).not.toThrow();
  });
});
