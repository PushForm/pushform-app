// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { materialStageSchema, MATERIAL_ASSET_LIMITS, type MaterialAppearance } from '@pushform/extension-protocol';
import { MaterialAppearanceStaging } from './materialAssets';

const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB7sAAAAASUVORK5CYII='), value => value.charCodeAt(0));
const appearance: MaterialAppearance = { name: 'Maple', color: [.3123, .4234, .5345], opacity: .75,
  texture: { widthM: .6, heightM: 1.2, colorize: true, colorizeType: 'tint', grain: 'height', image: { name: 'maple.png', mime: 'image/png', width: 1, height: 1, byteLength: bytes.length } } };
const stores: MaterialAppearanceStaging[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); });
function staging(now?: () => number) { const store = new MaterialAppearanceStaging(now); stores.push(store); return store; }
const input = (value: unknown) => materialStageSchema.parse({ expectedRevision: 7, ...value as object });

it('assembles detached sequential chunks without changing appearance data and bounds completed handles to their document/session', () => {
  const store = staging(), chunk = bytes.slice(0, 12);
  const start = store.stage('one', 7, input({ appearance, bytes: chunk }));
  chunk.fill(0); expect(start.complete).toBe(false);
  expect(() => store.resolve('one', 7, [{ op: 'add_material_appearance', asset: start.upload }])).toThrow(/incomplete/);
  expect(() => store.stage('one', 7, input({ upload: start.upload, offset: 4, bytes: bytes.slice(12) }))).toThrow(/sequential/);
  const end = store.stage('one', 7, input({ upload: start.upload, offset: 12, bytes: bytes.slice(12) }));
  expect(end).toMatchObject({ received: bytes.length, complete: true });
  const resolved = store.resolve('one', 7, [{ op: 'add_material_appearance', asset: start.upload }]);
  expect(resolved.get(start.upload)!.bytes).toEqual(bytes); expect(resolved.get(start.upload)!.appearance).toEqual(appearance);
  expect(() => store.resolve('two', 7, [{ op: 'add_material_appearance', asset: start.upload }])).toThrow(/another document/);
  expect(() => staging().resolve('one', 7, [{ op: 'add_material_appearance', asset: start.upload }])).toThrow(/another document/);
  expect(() => store.resolve('one', 8, [{ op: 'add_material_appearance', asset: start.upload }])).toThrow(/different model revision/);
  store.consume(resolved);
  expect(() => store.resolve('one', 7, [{ op: 'add_material_appearance', asset: start.upload }])).toThrow(/unavailable/);
});

it('refuses invalid raster metadata, stale and oversized chunks without producing a complete handle', () => {
  const store = staging();
  expect(() => store.stage('one', 8, input({ appearance, bytes }))).toThrow(/model changed/);
  for (const image of [{ ...appearance.texture!.image, mime: 'image/jpeg' }, { ...appearance.texture!.image, width: 2 }])
    expect(() => store.stage('one', 7, input({ appearance: { ...appearance, texture: { ...appearance.texture, image } }, bytes }))).toThrow(/signature or pixel dimensions/);
  expect(materialStageSchema.safeParse({ expectedRevision: 7, appearance, bytes: new Uint8Array(MATERIAL_ASSET_LIMITS.chunkBytes + 1) }).success).toBe(false);
  expect(materialStageSchema.safeParse({ expectedRevision: 7, appearance, bytes: null }).success).toBe(false);
  expect(materialStageSchema.safeParse({ expectedRevision: 7, appearance: { ...appearance, texture: { ...appearance.texture, image: { ...appearance.texture!.image, byteLength: MATERIAL_ASSET_LIMITS.imageBytes + 1 } } } }).success).toBe(false);
  // Bad initial chunks release their reserved slot even though no handle was returned.
  for (let i = 0; i < 20; i++) expect(() => store.stage('one', 7, input({ appearance, bytes: new Uint8Array(bytes.length + 1) }))).toThrow(/sequential/);
  expect(store.stage('one', 7, input({ appearance, bytes })).complete).toBe(true);
});

it('discards, expires and closes staged bytes and enforces session concurrency and byte reservations', () => {
  let now = 0; const store = staging(() => now);
  const start = store.stage('one', 7, input({ appearance }));
  store.stage('one', 8, input({ upload: start.upload, discard: true }));
  expect(() => store.resolve('one', 7, [{ op: 'add_material_appearance', asset: start.upload }])).toThrow(/unavailable/);
  const expired = store.stage('one', 7, input({ appearance })); now = MATERIAL_ASSET_LIMITS.lifetimeMs;
  expect(() => store.resolve('one', 7, [{ op: 'add_material_appearance', asset: expired.upload }])).toThrow(/expired/);
  for (let i = 0; i < MATERIAL_ASSET_LIMITS.uploads; i++) store.stage('one', 7, input({ appearance: { ...appearance, texture: null } }));
  expect(() => store.stage('one', 7, input({ appearance }))).toThrow(/quota/); store.closed('one');
  const large = { ...appearance, texture: { ...appearance.texture, image: { ...appearance.texture!.image, byteLength: MATERIAL_ASSET_LIMITS.imageBytes } } };
  store.stage('one', 7, input({ appearance: large })); store.stage('two', 7, input({ appearance: large }));
  expect(() => store.stage('three', 7, input({ appearance }))).toThrow(/quota/);
  store.closed('two'); expect(store.stage('three', 7, input({ appearance })).received).toBe(0);
  store.dispose(); expect(() => store.resolve('one', 7, [{ op: 'add_material_appearance', asset: expired.upload }])).toThrow(/unavailable/);
});
