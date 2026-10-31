// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import type { DefId, Id, MaterialId } from '@pushform/core';
import { allocId, createDocument, validateMeshPartGeometry } from '@pushform/model';
import type { MeshPart, MeshPartGeometry } from '@pushform/model';
import { encodeNativeMeshPartReference, decodeNativeMeshPartReference } from './meshPart';
import type { NativeMeshPartReference } from './meshPart';
import { encodeNativeModelRecord, decodeNativeModelRecord } from './modelRecord';
import { writeNativeModel } from './modelWriter';
import { readNativeModel } from './modelReader';
import { nativeModelState } from './modelState';
import { openNativeDocumentIndex, NATIVE_CAPABILITY_MESH_PARTS } from './documentRoot';
import { modelSessionJson, decodeModelSessionJson } from '../modelSession';

const root = new protobuf.Root();
for (const file of ['./meshReference.proto', './meshPart.proto']) protobuf.parse(readFileSync(new URL(file, import.meta.url), 'utf8'), root, { keepCase: true });

/** A unit box as a mesh part: 8 vertices, 12 triangles on 6 source faces, 12 edges, two face colors. */
function boxGeometry(materials: [MaterialId, MaterialId]): MeshPartGeometry {
  const positions = Float64Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];
  const triangles: number[] = [], triangleFace: number[] = [];
  faces.forEach((ring, f) => { triangles.push(ring[0]!, ring[1]!, ring[2]!, ring[0]!, ring[2]!, ring[3]!); triangleFace.push(f, f); });
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edgePositions: number[] = [], edgeOffsets = [0];
  for (const [a, b] of edges) { edgePositions.push(...positions.subarray(a! * 3, a! * 3 + 3), ...positions.subarray(b! * 3, b! * 3 + 3)); edgeOffsets.push(edgePositions.length / 3); }
  return { positions, triangles: Uint32Array.from(triangles), triangleFace: Uint32Array.from(triangleFace), faceCount: 6,
    faceMaterials: Uint32Array.from([materials[0], 0, materials[1], 0, 0, 0]), edgeOffsets: Uint32Array.from(edgeOffsets),
    edgePositions: Float64Array.from(edgePositions), edgeFlags: Uint8Array.from([0, 0, 0, 0, 1, 3, 0, 0, 2, 0, 0, 0]) };
}
function sink() {
  const parts: Uint8Array[] = [];
  return { write: async (bytes: Uint8Array) => { parts.push(bytes.slice()); }, bytes: () => {
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { all.set(p, at); at += p.length; } return all;
  } };
}
const source = (bytes: Uint8Array) => ({ size: bytes.length, read: async (offset: number, length: number) => bytes.subarray(offset, offset + length) });

describe('native mesh part records', () => {
  it('round-trips the reference through the codec, the model record envelope and the proto schema', () => {
    const ref: NativeMeshPartReference = { id: 7, properties: 2, name: 'Leg', sourceFormat: 'STEP', sourceSystem: 'FreeCAD', materialId: 5,
      faceCount: 6, edgeCount: 12, edgePointCount: 24, mesh: { vertexCount: 8, triangleCount: 12, vertexChunks: [10], triangleChunks: [11], faceIdChunks: [12], unknownFields: [] },
      faceMaterialChunks: [13], edgeOffsetChunks: [14], edgePositionChunks: [15, 16], edgeFlagChunks: [17], unknownFields: [new Uint8Array([0x98, 6, 7])] };
    const bytes = encodeNativeMeshPartReference(ref);
    expect(decodeNativeMeshPartReference(bytes)).toEqual(ref);
    const envelope = encodeNativeModelRecord({ kind: 'meshPart', value: ref, ownerDefinitionId: 3 as DefId });
    const record = decodeNativeModelRecord(envelope);
    expect(record.kind).toBe('meshPart');
    expect(encodeNativeModelRecord(record)).toEqual(envelope);
    const known = encodeNativeMeshPartReference({ ...ref, unknownFields: [] }), schema = root.lookupType('pushform.native.MeshPart');
    expect(Array.from(schema.encode(schema.decode(known)).finish())).toEqual(Array.from(known));
    // Chunk ids may not repeat across columns, and a column is present exactly when it has rows.
    expect(() => encodeNativeMeshPartReference({ ...ref, edgeFlagChunks: [13] })).toThrow();
    expect(() => encodeNativeMeshPartReference({ ...ref, edgeCount: 0 })).toThrow();
    expect(() => decodeNativeModelRecord(encodeNativeModelRecord({ kind: 'unknown', wireKind: 17, schemaMajor: 1, required: false, payload: new Uint8Array() }))).toThrow();
  });

  it('saves a document with mesh parts under capability 1 and reads it back whole; a reader without the capability refuses it', async () => {
    const doc = createDocument();
    doc.transact('mesh part', d => {
      const e = d.definitions.get(d.rootDefinitionId)!.entities;
      const red = allocId<MaterialId>(d), blue = allocId<MaterialId>(d);
      const base = d.materials.get(d.defaultMaterialId)!;
      d.materials.set(red, { ...base, id: red, name: 'Red' });
      d.materials.set(blue, { ...base, id: blue, name: 'Blue' });
      const id = allocId<Id>(d);
      const part: MeshPart = { tagId: d.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {},
        id, name: 'Leg', source: { format: 'STEP', system: 'FreeCAD' }, geometry: boxGeometry([red, blue]), materialId: blue };
      validateMeshPartGeometry(part.geometry);
      e.meshParts.set(id, part as never); e.order.push(id);
    });
    const output = sink();
    await writeNativeModel(doc.state, output, { pageBytes: 64 });
    const bytes = output.bytes();
    const index = await openNativeDocumentIndex(source(bytes), new Set([NATIVE_CAPABILITY_MESH_PARTS]), () => true);
    expect(index.root.requiredCapabilities).toEqual([NATIVE_CAPABILITY_MESH_PARTS]);
    await expect(openNativeDocumentIndex(source(bytes), new Set(), () => true)).rejects.toThrow(/Unsupported required native capability: 1/);
    const staged = await readNativeModel(source(bytes));
    const state = nativeModelState(staged);
    expect(state).toEqual(doc.state);
    const part = [...state.definitions.get(state.rootDefinitionId)!.entities.meshParts.values()][0]!;
    expect(part.geometry.triangles.length / 3).toBe(12);
    expect(part.geometry.edgeOffsets.length).toBe(13);
    // A document without mesh parts declares no capability, so older readers still open it.
    const plain = sink();
    await writeNativeModel(createDocument().state, plain, { pageBytes: 64 });
    expect((await openNativeDocumentIndex(source(plain.bytes()), new Set(), () => true)).root.requiredCapabilities).toEqual([]);
  });

  it('keeps mesh parts through the JSON session snapshot and defaults the map for older snapshots', () => {
    const doc = createDocument();
    doc.transact('mesh part', d => {
      const e = d.definitions.get(d.rootDefinitionId)!.entities, id = allocId<Id>(d);
      e.meshParts.set(id, { tagId: d.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {},
        id, name: 'Seat', source: { format: 'STL', system: '' }, geometry: boxGeometry([0 as MaterialId, 0 as MaterialId]), materialId: null }); e.order.push(id);
    });
    expect(decodeModelSessionJson(modelSessionJson(doc.state))).toEqual(doc.state);
    const older = JSON.parse(modelSessionJson(createDocument().state)) as { definitions: { $map: [number, { entities: Record<string, unknown> }][] } };
    for (const [, definition] of older.definitions.$map) delete definition.entities.meshParts;
    const revived = decodeModelSessionJson(JSON.stringify(older));
    expect([...revived.definitions.values()].every(d => d.entities.meshParts instanceof Map && d.entities.meshParts.size === 0)).toBe(true);
  });
});
