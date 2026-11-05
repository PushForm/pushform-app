// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import type { Id, ImageId } from '@pushform/core';
import {
  createDocumentState,
  defaultSceneLight,
  environmentPreset,
  hashImageBytes,
} from '@pushform/model';
import {
  decodeNativeEnvironment,
  encodeNativeEnvironment,
  decodeNativeSceneLight,
  encodeNativeSceneLight,
} from './environment';
import { encodeNativeStyle, decodeNativeStyle } from './style';
import { encodeModelSnapshot, openModelFile } from '../nativeFileClient';

it('round trips each environment and a placed light with bounded values', () => {
  for (const name of ['bright', 'soft', 'daylight', 'night'] as const) {
    const value = environmentPreset(name);
    expect(decodeNativeEnvironment(encodeNativeEnvironment(value)).value).toEqual(value);
  }
  const light = { ...defaultSceneLight('area'), id: 100 as Id };
  expect(decodeNativeSceneLight(encodeNativeSceneLight(light))).toEqual(light);
  expect(() =>
    encodeNativeEnvironment({ ...environmentPreset('bright'), fill: Infinity }),
  ).toThrow();
  expect(() => encodeNativeSceneLight({ ...light, lumens: -1 })).toThrow();
});
it('preserves legacy styles without adding an environment on read', () => {
  const state = createDocumentState(),
    style = state.styles.get(state.activeStyleId)!;
  delete style.environment;
  expect(decodeNativeStyle(encodeNativeStyle(style)).value.environment).toBeUndefined();
});
it('saves model-owned lights separately from the active style', async () => {
  const state = createDocumentState();
  state.sceneLights = [{ ...defaultSceneLight(), id: state.meta.nextId++ as Id }];
  state.styles.get(state.activeStyleId)!.environment = environmentPreset('night');
  const file = await openModelFile(await encodeModelSnapshot(state, []));
  expect(file.state.sceneLights).toEqual(state.sceneLights);
  expect(file.state.styles.get(file.state.activeStyleId)?.environment?.preset).toBe('night');
});
it('refuses a native style that points to a missing skybox asset', async () => {
  const state = createDocumentState();
  state.styles.get(state.activeStyleId)!.environment = {
    ...environmentPreset('bright'),
    sky: 'image',
    skyboxImageId: 99 as ImageId,
  };
  await expect(Promise.resolve().then(() => encodeModelSnapshot(state, []))).rejects.toThrow();
});
it('round trips embedded skybox bytes and refuses duplicate persistent light IDs', async () => {
  const state = createDocumentState(),
    id = state.meta.nextId++ as ImageId;
  const bytes = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZbUAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  state.images.set(id, {
    id,
    name: 'sky.png',
    mime: 'image/png',
    width: 1,
    height: 1,
    sha256: await hashImageBytes(bytes),
  });
  state.styles.get(state.activeStyleId)!.environment = {
    ...environmentPreset('bright'),
    sky: 'image',
    skyboxImageId: id,
  };
  const file = await openModelFile(
    await encodeModelSnapshot(state, [{ id, blob: { bytes, mime: 'image/png' } }]),
  );
  expect(file.state.styles.get(file.state.activeStyleId)?.environment?.skyboxImageId).toBe(id);
  expect(file.images.get(id)?.bytes).toEqual(bytes);
  state.sceneLights = [{ ...defaultSceneLight(), id: state.activeStyleId as unknown as Id }];
  await expect(
    Promise.resolve().then(async () =>
      openModelFile(await encodeModelSnapshot(state, [{ id, blob: { bytes, mime: 'image/png' } }])),
    ),
  ).rejects.toThrow();
});
