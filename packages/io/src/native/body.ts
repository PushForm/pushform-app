// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { FaceLocalId, MeshData } from '@pushform/core';
import type { Body, CommonAttrs } from '@pushform/model';
import { validateSolidMesh } from '@pushform/kernel';
import { NativeRecordCodec } from './record';
import { NativeChunkError, NATIVE_MAX_CHUNKS } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeColumnReader } from './columns';
import type { NativeStoredChunk } from './container';
import type { NativeCommonPropertyReader } from './commonProperty';
import { streamNativeMesh, readNativeMesh, encodeNativeMeshReference, decodeNativeMeshReference } from './mesh';
import type { NativeMeshReference } from './mesh';
import { streamNativeBodyFaces, readNativeBodyFaces, encodeNativeBodyFacesReference, decodeNativeBodyFacesReference } from './bodyFaces';
import type { NativeBodyFacesReference } from './bodyFaces';
import { streamNativeBodyEdges, readNativeBodyEdges, encodeNativeBodyEdgesReference, decodeNativeBodyEdgesReference } from './bodyEdges';
import type { NativeBodyEdgesReference } from './bodyEdges';
import { streamNativeBodyCurves, readNativeBodyCurves, validateNativeBodyCurveEdges, encodeNativeBodyCurvesReference, decodeNativeBodyCurvesReference } from './bodyCurves';
import type { NativeBodyCurvesReference } from './bodyCurves';
import { streamNativeBodySurfaces, readNativeBodySurfaces, encodeNativeBodySurfacesReference, decodeNativeBodySurfacesReference } from './bodySurfaces';
import type { NativeBodySurfacesReference } from './bodySurfaces';
import { streamNativeImprint, readNativeImprint, encodeNativeImprintReference, decodeNativeImprintReference } from './imprint';
import type { NativeImprintReference, NativePackedImprint } from './imprint';

export interface NativeBodyReference {
  id: number; version: number; nextFaceId: number; materialId: number | null; properties: number; valid: boolean; volume: number; area: number;
  mesh: NativeMeshReference; faces: NativeBodyFacesReference; edges: NativeBodyEdgesReference; curves: NativeBodyCurvesReference;
  surfaces: NativeBodySurfacesReference; imprints: NativeImprintReference[]; unknownFields: Uint8Array[];
}
export type NativeBodyExtensions = Map<string, Uint8Array[]>;
const codec = new NativeRecordCodec({ id: { id: 1, kind: 'uint32', required: true }, version: { id: 2, kind: 'uint53', required: true },
  nextFaceId: { id: 3, kind: 'uint53', required: true }, materialId: { id: 4, kind: 'uint32', required: false }, properties: { id: 5, kind: 'uint32', required: true },
  valid: { id: 6, kind: 'bool', required: true }, volume: { id: 7, kind: 'double', required: true }, area: { id: 8, kind: 'double', required: true },
  mesh: { id: 9, kind: 'bytes', required: true }, faces: { id: 10, kind: 'bytes', required: true }, edges: { id: 11, kind: 'bytes', required: true },
  curves: { id: 12, kind: 'bytes', required: true }, surfaces: { id: 13, kind: 'bytes', required: true }, imprints: { id: 14, kind: 'bytes', required: false, repeated: true } });
const fail = (): never => { throw new NativeChunkError('Invalid native body'); };
function validate(ref: NativeBodyReference): void {
  if (!Number.isInteger(ref.properties) || ref.properties < 1 || ref.properties > 0xffff_ffff || !Number.isSafeInteger(ref.nextFaceId) ||
    ref.nextFaceId < 0 || ref.nextFaceId > 0x1_0000_0000 || !Number.isFinite(ref.volume) || !Number.isFinite(ref.area)) fail();
  const used = new Set<number>(), faces = new Set<number>();
  const groups = [ref.mesh.vertexChunks, ref.mesh.triangleChunks, ref.mesh.faceIdChunks, ...Object.values(ref.faces.columns),
    ref.faces.uv.kindChunks, ref.faces.uv.offsetChunks, ref.faces.uv.valueChunks, ...Object.values(ref.edges.columns),
    ...Object.values(ref.curves.columns), ...Object.values(ref.surfaces.columns)];
  for (const imprint of ref.imprints) { if (faces.has(imprint.faceId)) fail(); faces.add(imprint.faceId); groups.push(...Object.values(imprint.columns)); }
  for (const ids of groups) for (const id of ids) { if (used.has(id)) fail(); used.add(id); }
  if (used.size > NATIVE_MAX_CHUNKS) fail();
}
export function encodeNativeBodyReference(ref: NativeBodyReference): Uint8Array {
  validate(ref); return codec.encode({ fields: { id: ref.id, version: ref.version, nextFaceId: ref.nextFaceId, properties: ref.properties, valid: ref.valid,
    volume: ref.volume, area: ref.area, ...(ref.materialId === null ? {} : { materialId: ref.materialId }),
    mesh: encodeNativeMeshReference(ref.mesh), faces: encodeNativeBodyFacesReference(ref.faces), edges: encodeNativeBodyEdgesReference(ref.edges),
    curves: encodeNativeBodyCurvesReference(ref.curves), surfaces: encodeNativeBodySurfacesReference(ref.surfaces), imprints: ref.imprints.map(encodeNativeImprintReference) }, unknownFields: ref.unknownFields });
}
export function decodeNativeBodyReference(bytes: Uint8Array): NativeBodyReference {
  const decoded = codec.decode(bytes), f = decoded.fields;
  const ref: NativeBodyReference = { id: f.id as number, version: f.version as number, nextFaceId: f.nextFaceId as number,
    materialId: f.materialId === undefined ? null : f.materialId as number, properties: f.properties as number, valid: f.valid as boolean,
    volume: f.volume as number, area: f.area as number, mesh: decodeNativeMeshReference(f.mesh as Uint8Array), faces: decodeNativeBodyFacesReference(f.faces as Uint8Array),
    edges: decodeNativeBodyEdgesReference(f.edges as Uint8Array), curves: decodeNativeBodyCurvesReference(f.curves as Uint8Array),
    surfaces: decodeNativeBodySurfacesReference(f.surfaces as Uint8Array), imprints: ((f.imprints ?? []) as Uint8Array[]).map(decodeNativeImprintReference), unknownFields: decoded.unknownFields };
  validate(ref); return ref;
}
function scopes(ref: NativeBodyReference): [string, { unknownFields: Uint8Array[] }][] {
  return [['', ref], ['mesh', ref.mesh], ['faces', ref.faces], ['faces.uv', ref.faces.uv], ['edges', ref.edges], ['curves', ref.curves], ['surfaces', ref.surfaces],
    ...ref.imprints.map((r): [string, NativeImprintReference] => [`imprints/${r.faceId}`, r])];
}
export async function* streamNativeBody(body: Body, propertyId: (value: CommonAttrs) => number, nextId: () => number,
  options: NativeChunkOptions = {}, extensions: NativeBodyExtensions = new Map()): AsyncGenerator<NativeStoredChunk, NativeBodyReference> {
  const mesh = yield* streamNativeMesh(body.mesh, nextId, options), faces = yield* streamNativeBodyFaces(body.faces, nextId, options),
    edges = yield* streamNativeBodyEdges(body.edges, nextId, options), curves = yield* streamNativeBodyCurves(body.curves, nextId, options),
    surfaces = yield* streamNativeBodySurfaces(body.surfaces, nextId, options);
  const imprints: NativeImprintReference[] = [];
  for (const [faceId, graph] of body.imprints) imprints.push(yield* streamNativeImprint(faceId, graph, nextId, options));
  const ref: NativeBodyReference = { id: body.id, version: body.version, nextFaceId: body.nextFaceId, materialId: body.materialId, properties: propertyId(body),
    valid: body.valid, volume: body.props.volume, area: body.props.area, mesh, faces, edges, curves, surfaces, imprints, unknownFields: [] };
  for (const [name, value] of scopes(ref)) value.unknownFields = extensions.get(name) ?? [];
  for (const imprint of ref.imprints) imprint.unknownFields = body.imprints.get(imprint.faceId as FaceLocalId)!.nativeUnknownFields ?? imprint.unknownFields;
  validate(ref); return ref;
}
/** Kernel validation never changes canonical columns; this staging reader does not install a Document. */
export async function readNativeBody(ref: NativeBodyReference, columns: NativeColumnReader, properties: NativeCommonPropertyReader,
  hasMaterial: (id: number) => boolean, hasTag: (id: number) => boolean,
  validateSolid: (mesh: MeshData, signal?: AbortSignal) => Promise<void> = validateSolidMesh, signal?: AbortSignal) {
  validate(ref); const common = properties.get(ref.properties);
  if (!hasTag(common.value.tagId) || (ref.materialId !== null && !hasMaterial(ref.materialId))) return fail();
  const mesh = await readNativeMesh(ref.mesh, columns, signal);
  await validateSolid(mesh, signal); signal?.throwIfAborted();
  const curves = await readNativeBodyCurves(ref.curves, columns, signal), curveIndex = columns.indexIds(curves.ids, signal);
  // Surface and face records refer to one another. Resolve faces first, then close the cycle below.
  const faces = await readNativeBodyFaces(ref.faces, columns, hasMaterial, hasTag, () => true, signal), faceIndex = columns.indexIds(faces.ids, signal);
  for (const id of faces.ids) if (id >= ref.nextFaceId) return fail();
  for (const id of mesh.faceId) if (!faceIndex.has(id)) return fail();
  const surfaces = await readNativeBodySurfaces(ref.surfaces, columns, id => faceIndex.has(id), id => curveIndex.has(id), signal), surfaceIndex = columns.indexIds(surfaces.ids, signal);
  for (let row = 0; row < faces.ids.length; row++) if ((faces.flags[row]! & 8) && !surfaceIndex.has(faces.properties[row * 4 + 3]!)) return fail();
  const edges = await readNativeBodyEdges(ref.edges, columns, id => faceIndex.has(id), hasTag, id => curveIndex.has(id), signal);
  validateNativeBodyCurveEdges(curves, edges.index);
  const imprints: NativePackedImprint[] = [];
  for (const imprint of ref.imprints) imprints.push(await readNativeImprint(imprint, columns, id => faceIndex.has(id), id => curveIndex.has(id), signal));
  const extensions: NativeBodyExtensions = new Map(); for (const [name, value] of scopes(ref)) if (value.unknownFields.length) extensions.set(name, value.unknownFields);
  return { id: ref.id, version: ref.version, nextFaceId: ref.nextFaceId, materialId: ref.materialId, common: common.value, valid: ref.valid,
    props: { volume: ref.volume, area: ref.area }, mesh, faces, edges, curves, surfaces, imprints, indexes: { faces: faceIndex, curves: curveIndex, surfaces: surfaceIndex }, extensions };
}
export type NativePackedBody = Awaited<ReturnType<typeof readNativeBody>>;
