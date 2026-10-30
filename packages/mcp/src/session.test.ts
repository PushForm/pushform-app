// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { allocId, createDocument, ImageStore } from '@pushform/model';
import type { ImageId } from '@pushform/core';
import { encodeModelSnapshot, modelArchiveImages, modelContentIdentity, openModelFile } from '@pushform/io';
import { HeadlessSession } from './session';

const sessions: HeadlessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });
function session(): HeadlessSession { const s = new HeadlessSession(); sessions.push(s); return s; }

it('opens application-native bytes with image assets and saves the captured revision', async () => {
  const doc = createDocument(), images = new ImageStore(), bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const asset = doc.transact('image', d => {
    const id = allocId<ImageId>(d), asset = { id, name: 'tile.png', mime: 'image/png', width: 1, height: 1, sha256: 'fixture' };
    d.images.set(id, asset); return asset;
  }).value;
  images.register(asset, bytes);
  const s = session();
  await s.load(await encodeModelSnapshot(doc.state, modelArchiveImages(doc.state, images)), 'input.pf');
  expect(s.path).toBe('input.pf'); expect(s.model.host.images.get(asset.id)!.bytes).toEqual(bytes);
  const captured = modelContentIdentity(s.model.host.doc.state), encoding = s.model.encode();
  s.model.host.doc.transact('later', d => { d.definitions.get(d.rootDefinitionId)!.name = 'Later'; });
  const reopened = await openModelFile(await encoding);
  expect(reopened.contentIdentity).toBe(captured);
  expect(reopened.images.get(asset.id)!.bytes).toEqual(bytes);
  expect(modelContentIdentity(s.model.host.doc.state)).not.toBe(captured);
});

it('keeps the open model and path when native validation rejects a file', async () => {
  const s = session(), native = await s.model.encode();
  await s.load(native, 'existing.pf');
  const model = s.model;
  const invalidHeader = native.slice(); invalidHeader[0] = 0;
  for (const invalid of [native.subarray(0, native.length - 1), invalidHeader]) {
    await expect(s.load(invalid, 'bad.pf')).rejects.toThrow();
    expect(s.model).toBe(model); expect(s.path).toBe('existing.pf');
  }
});
