// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import { DEFAULT_SHADOWS } from '@pushform/model';
import type { LayoutViewport, LayoutModelArchive, ModelReference } from '@pushform/layout';
import { decodeNativeLayoutViewport, encodeNativeLayoutViewport, validateNativeLayoutViewportReferences } from './layoutViewport';
const root = protobuf.parse(readFileSync(new URL('./layoutViewport.proto', import.meta.url), 'utf8')).root;
const schema = root.lookupType('pushform.native.LayoutViewport'), displaySchema = root.lookupType('pushform.native.LayoutViewportDisplay');
function fixture(): LayoutViewport {
  const camera = { eye: [-0, 2, 3] as [number, number, number], target: [4, 5, 6] as [number, number, number], up: [0, 0, 1] as [number, number, number],
    projection: 'parallel' as const, fov: 45.125, scale: 0.02, shift: [-0, 0.25] as [number, number] };
  return { source: { archiveId: 'archive', modelReferenceId: 'model' }, templateId: 'template', originalId: 'original', camera, scene: '', background: null,
    preserveScaleOnResize: false, cache: { camera: { ...camera, projection: 'perspective' }, widthMm: 123.125, heightMm: 99.5, sha256: 'a'.repeat(64) },
    display: { faceStyle: 'shadedTextured', edges: true, profiles: false, backEdges: true, xray: false, hiddenGeometry: true, shadows: { ...DEFAULT_SHADOWS } } };
}
it('round trips embedded/cloud sources, exact cameras, cache and all display styles', () => {
  for (const faceStyle of ['wireframe', 'hiddenLine', 'shaded', 'shadedTextured', 'monochrome'] as const) for (const cloud of [false, true]) {
    const value = fixture(); value.display!.faceStyle = faceStyle;
    if (cloud) { value.source = { referenceId: 42 }; value.templateId = null; value.originalId = null; }
    const bytes = encodeNativeLayoutViewport(value), next = decodeNativeLayoutViewport(bytes).value;
    expect(next).toEqual(value); expect(Object.is(next.camera.eye[0], -0)).toBe(true); expect(Object.is(next.camera.shift![0], -0)).toBe(true);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  }
});
it('distinguishes absent, undefined, false and empty metadata without inventing defaults', () => {
  for (const state of ['absent', 'undefined', 'present']) {
    const value = fixture();
    for (const [target, key] of [[value, 'display'], [value, 'preserveScaleOnResize'], [value.camera, 'shift'], [value.cache!, 'sha256']] as const) {
      Reflect.deleteProperty(target, key);
      if (state === 'undefined') Object.defineProperty(target, key, { value: undefined, enumerable: true });
    }
    if (state === 'present') { value.display = fixture().display!; value.preserveScaleOnResize = true; value.camera.shift = [0, 0]; value.cache!.sha256 = ''; }
    const next = decodeNativeLayoutViewport(encodeNativeLayoutViewport(value)).value;
    expect(next).toEqual(value); expect(Object.hasOwn(next.camera, 'shift')).toBe(state !== 'absent');
    expect(Object.hasOwn(next, 'display')).toBe(state !== 'absent'); expect(Object.hasOwn(next.cache!, 'sha256')).toBe(state !== 'absent');
  }
  const value = fixture(); value.cache = null; value.scene = null; value.background = '';
  expect(decodeNativeLayoutViewport(encodeNativeLayoutViewport(value)).value).toEqual(value);
});
it('owns and preserves extension bytes through camera edits at every nested scope', () => {
  const fields = [new Uint8Array([0x98, 6, 7])];
  const extensions = { records: new Map(['', 'source', 'camera', 'cache', 'cache.camera', 'cache.sha256', 'display', 'display.value', 'display.shadows'].map(key => [key, fields])), shadows: new Map([['', fields]]) };
  const bytes = encodeNativeLayoutViewport(fixture(), extensions), decoded = decodeNativeLayoutViewport(bytes); bytes.fill(0);
  decoded.value.camera.eye[1] = 123;
  const next = decodeNativeLayoutViewport(encodeNativeLayoutViewport(decoded.value, decoded.extensions));
  expect(next.extensions).toEqual(extensions); expect(next.value.camera.eye[1]).toBe(123);
});
it('rejects ambiguous sources, malformed wrappers, unsupported enums and nonfinite coordinates', () => {
  const base = schema.toObject(schema.decode(encodeNativeLayoutViewport(fixture())));
  for (const patch of [{ source: { kind: 2 } }, { source: { kind: 1, referenceId: 0 } }, { source: { kind: 0, archiveId: 'a', modelReferenceId: 'm', referenceId: 1 } },
    { preserveScaleOnResize: 3 }, { camera: { ...base.camera, projection: 2 } }, { camera: { ...base.camera, fov: Infinity } },
    { camera: { ...base.camera, shift: new Uint8Array(8) } }, { display: { state: 0, value: new Uint8Array() } }, { display: { state: 1 } }]) {
    expect(() => decodeNativeLayoutViewport(schema.encode({ ...base, ...patch }).finish())).toThrow();
  }
  const d = displaySchema.toObject(displaySchema.decode(base.display.value)); d.faceStyle = 5;
  expect(() => decodeNativeLayoutViewport(schema.encode({ ...base, display: { state: 1, value: displaySchema.encode(d).finish() } }).finish())).toThrow();
  const value = fixture(); value.camera.eye[0] = NaN; expect(() => encodeNativeLayoutViewport(value)).toThrow();
});
it('validates staged cloud and embedded catalog references without fetching models', () => {
  const v = fixture(), archive: LayoutModelArchive = { format: 'sketchup-layout', archiveBase64: '', models: new Map([['model', { internalTarget: 'model.skp', externalTarget: null }]]), viewports: new Map() };
  const archives = new Map([['archive', archive]]);
  expect(() => validateNativeLayoutViewportReferences(v, new Map(), archives)).not.toThrow();
  expect(() => validateNativeLayoutViewportReferences(v, new Map(), new Map())).toThrow();
  v.source = { referenceId: 42 }; v.templateId = null; v.originalId = null;
  const ref: ModelReference = { id: 42, displayName: 'Model', target: { kind: 'cloud', documentId: 'd', revisionId: 'r', revisionNumber: 1, sha256: 'a'.repeat(64), pinned: false } };
  const refs = new Map([[42, ref]]);
  expect(() => validateNativeLayoutViewportReferences(v, refs, archives)).not.toThrow();
  expect(() => validateNativeLayoutViewportReferences(v, new Map(), archives)).toThrow();
  v.originalId = 'old'; expect(() => validateNativeLayoutViewportReferences(v, refs, archives)).toThrow();
  v.originalId = null; ref.target = { kind: 'path', path: 'model.skp', contentHash: null };
  expect(() => validateNativeLayoutViewportReferences(v, refs, archives)).toThrow();
});
