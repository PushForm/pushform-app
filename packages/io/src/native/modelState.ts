// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CurveId, FaceLocalId, Id, MaterialId, SurfaceId, TagId, Vec3 } from '@pushform/core';
import { createSketch, makeEdgeKey } from '@pushform/model';
import type { Body, Curve, DocumentState, MeshPart, Sketch, ImprintGraph } from '@pushform/model';
import type { NativePackedMeshPart } from './meshPart';
import type { NativePackedModel } from './modelReader';
import type { NativePackedSketch } from './sketch';
import type { NativePackedBody } from './body';
import type { NativeCommonPropertyReader } from './commonProperty';
import { nativeFaceUvAt } from './faceUv';

const xyz = (v: Float64Array, at: number): Vec3 => [v[at]!, v[at + 1]!, v[at + 2]!];
function geometry(v: Float64Array, row: number) {
  const at = row * 16;
  return { plane: { n: xyz(v, at), d: v[at + 3]! }, basis: { origin: xyz(v, at + 4), u: xyz(v, at + 7), v: xyz(v, at + 10), n: xyz(v, at + 13) } };
}
function curve(t: NativePackedSketch['curves'] | NativePackedBody['curves'], row: number, edgeRefs: Curve['edgeRefs']): Curve {
  const at = row * 9;
  return { id: t.ids[row]! as CurveId, kind: (['arc', 'circle', 'polygon', 'freehand'] as const)[t.kinds[row]!]!, center: xyz(t.geometry, at),
    normal: xyz(t.geometry, at + 3), radius: t.geometry[at + 6]!, startAngle: t.geometry[at + 7]!, endAngle: t.geometry[at + 8]!, segments: t.segments[row]!, edgeRefs };
}
/** Adapter for the existing transactional editor. Mesh buffers are reused; derived caches are rebuilt.
 * This expands editable face/sketch records and is not the eventual packed live model API. */
export function nativeSketchState(t: NativePackedSketch, properties: NativeCommonPropertyReader): Sketch {
  const s = createSketch();
  if (t.extensions.size) s.nativeUnknownFields = { extensions: t.extensions };
  if (t.vertices.ids.length) s.packedVertexIndex = { ...t.vertexSpatial.data, ids: t.vertices.ids };
  for (let r = 0; r < t.vertices.ids.length; r++) {
    const id = t.vertices.ids[r]! as Id, p = xyz(t.vertices.positions, r * 3);
    s.vertices.set(id, { id, p });
  }
  for (let r = 0; r < t.edges.ids.length; r++) {
    const e = t.edges, at = r * 4, flags = e.flags[r]!, id = e.ids[r]! as Id;
    s.edges.set(id, { ...properties.get(e.rows[at + 2]!).value, id, a: e.rows[at]! as Id, b: e.rows[at + 1]! as Id,
      soft: !!(flags & 1), smooth: !!(flags & 2), curveId: flags & 4 ? e.rows[at + 3]! as CurveId : null });
  }
  for (let r = 0; r < t.faces.ids.length; r++) {
    const f = t.faces, at = r * 3, flags = f.materialFlags[r]!, id = f.ids[r]! as Id, loops = [];
    for (let l = f.faceOffsets[r]!; l < f.faceOffsets[r + 1]!; l++) {
      const loop = []; for (let e = f.loopOffsets[l]!; e < f.loopOffsets[l + 1]!; e++) loop.push({ edgeId: f.edgeIds[e]! as Id, forward: !!f.forward[e] }); loops.push(loop);
    }
    s.faces.set(id, { ...properties.get(f.properties[at]!).value, id, ...geometry(f.geometry, r), loops,
      frontMaterialId: flags & 1 ? f.properties[at + 1]! as MaterialId : null, backMaterialId: flags & 2 ? f.properties[at + 2]! as MaterialId : null, ...nativeFaceUvAt(f.uv, r) });
  }
  for (let r = 0; r < t.curves.ids.length; r++) { const c = curve(t.curves, r, Array.from(t.curves.edgeIds.subarray(t.curves.offsets[r], t.curves.offsets[r + 1])) as Id[]); s.curves.set(c.id, c); }
  return s;
}
export function nativeBodyState(t: NativePackedBody): Body {
  const body: Body = { ...t.common, id: t.id as Id, version: t.version, nextFaceId: t.nextFaceId, mesh: t.mesh, materialId: t.materialId as MaterialId | null,
    valid: t.valid, props: t.props, faces: new Map(), edges: new Map(), curves: new Map(), surfaces: new Map(), imprints: new Map() };
  const extensions = new Map([...t.extensions].filter(([scope]) => !scope.startsWith('imprints/')));
  if (extensions.size) body.nativeUnknownFields = { extensions };
  for (let r = 0; r < t.faces.ids.length; r++) {
    const f = t.faces, at = r * 4, flags = f.flags[r]!, id = f.ids[r]! as FaceLocalId, loops: Vec3[][] = [];
    for (let l = f.faceOffsets[r]!; l < f.faceOffsets[r + 1]!; l++) { const loop: Vec3[] = []; for (let p = f.loopOffsets[l]!; p < f.loopOffsets[l + 1]!; p++) loop.push(xyz(f.positions, p * 3)); loops.push(loop); }
    body.faces.set(id, { id, ...geometry(f.geometry, r), loops, frontMaterialId: flags & 1 ? f.properties[at]! as MaterialId : null,
      backMaterialId: flags & 2 ? f.properties[at + 1]! as MaterialId : null, tagId: f.properties[at + 2]! as TagId, hidden: !!(flags & 4), surfaceId: flags & 8 ? f.properties[at + 3]! as SurfaceId : null, ...nativeFaceUvAt(f.uv, r) });
  }
  for (let r = 0; r < t.edges.flags.length; r++) {
    const e = t.edges, at = r * 5, flags = e.flags[r]!, key = makeEdgeKey(e.rows[at]!, e.rows[at + 1]!, e.rows[at + 2]!), polyline: Vec3[] = [];
    for (let p = e.offsets[r]!; p < e.offsets[r + 1]!; p++) polyline.push(xyz(e.positions, p * 3));
    body.edges.set(key, { key, faceA: e.rows[at]! as FaceLocalId, faceB: e.rows[at + 1]! as FaceLocalId, polyline, tagId: e.rows[at + 3]! as TagId,
      soft: !!(flags & 1), smooth: !!(flags & 2), hidden: !!(flags & 4), curveId: flags & 8 ? e.rows[at + 4]! as CurveId : null });
  }
  for (let r = 0; r < t.curves.ids.length; r++) {
    const c = t.curves, refs: Curve['edgeRefs'] = []; for (let e = c.offsets[r]!; e < c.offsets[r + 1]!; e++) refs.push(makeEdgeKey(c.edgeKeys[e * 3]!, c.edgeKeys[e * 3 + 1]!, c.edgeKeys[e * 3 + 2]!));
    const value = curve(c, r, refs); body.curves.set(value.id, value);
  }
  for (let r = 0; r < t.surfaces.ids.length; r++) {
    const s = t.surfaces, id = s.ids[r]! as SurfaceId;
    body.surfaces.set(id, { id, curveId: s.flags[r] ? s.curves[r]! as CurveId : null, faceIds: Array.from(s.faces.subarray(s.offsets[r], s.offsets[r + 1])) as FaceLocalId[] });
  }
  for (const p of t.imprints) {
    const graph: ImprintGraph = { nextId: p.nextId, version: p.version, vertices: new Map(), edges: new Map() };
    if (p.unknownFields.length) graph.nativeUnknownFields = p.unknownFields;
    for (let r = 0; r < p.vertexIds.length; r++) graph.vertices.set(p.vertexIds[r]!, [p.positions[r * 2]!, p.positions[r * 2 + 1]!]);
    for (let r = 0; r < p.edgeIds.length; r++) { const id = p.edgeIds[r]!, flags = p.flags[r]!; graph.edges.set(id, { id, a: p.endpoints[r * 2]!, b: p.endpoints[r * 2 + 1]!, soft: !!(flags & 1), smooth: !!(flags & 2), hidden: !!(flags & 4), curveId: flags & 8 ? p.curves[r]! as CurveId : null }); }
    body.imprints.set(p.faceId as FaceLocalId, graph);
  }
  return body;
}
export function nativeMeshPartState(t: NativePackedMeshPart): MeshPart {
  const part: MeshPart = { ...t.common, id: t.id, name: t.name, source: t.source, geometry: t.geometry, materialId: t.materialId };
  if (t.unknownFields.length) part.nativeUnknownFields = { extensions: new Map([['', t.unknownFields]]) };
  return part;
}
export function nativeModelState(model: NativePackedModel): DocumentState {
  // Reject extension scopes not yet connected to editable ownership before installation.
  // Supported root/settings/catalog/definition fields are installed with their owners below.
  if (model.hasUnsupportedExtensions) throw new Error('This model contains extensions this editor cannot preserve. Open it with a newer version.');
  const definitions: DocumentState['definitions'] = new Map();
  for (const [id, d] of model.definitions) {
    const sketch = nativeSketchState(d.sketch!, model.properties);
    const bodies = new Map([...d.bodies].map(([key, packed]) => {
      const body = nativeBodyState(packed);
      attachEnvelope(body, model.extras.get(`body/${key}`));
      return [key, body] as const;
    }));
    const meshParts = new Map([...d.meshParts].map(([key, packed]) => {
      const part = nativeMeshPartState(packed);
      attachEnvelope(part, model.extras.get(`meshPart/${key}`));
      return [key, part] as const;
    }));
    attachEnvelope(sketch, model.extras.get(`sketch/${id}`));
    const extra = model.extras.get(`definition/${id}`);
    const nativeUnknownFields = {
      ...(extra?.required === false ? { required: false } : {}),
      ...(extra?.envelopeUnknown?.length ? { envelopeUnknown: extra.envelopeUnknown } : {}),
      ...(d.extensions.size ? { extensions: d.extensions } : {}),
    };
    definitions.set(id, { ...d.metadata, bounds: null,
      ...(Object.keys(nativeUnknownFields).length ? { nativeUnknownFields } : {}), entities: {
    bodies, meshParts, sketch,
    instances: d.instances, guides: d.guides, images: d.images, sectionPlanes: d.sectionPlanes, texts: d.texts, dimensions: d.dimensions,
    activeSectionPlaneId: d.activeSectionPlaneId, order: Array.from(d.order) as Id[],
    } });
  }
  const styles = model.catalogs.styleUnknownFields();
  const scenes = model.catalogs.sceneUnknownFields();
  const images = model.catalogs.imageUnknownFields();
  const materials = model.catalogs.materialUnknownFields();
  const tags = model.catalogs.tagUnknownFields();
  const settings = model.settingsExtensions;
  const hasSettings = settings.records.size || settings.meta.size || settings.shadows.size || settings.fog?.size;
  return { ...model.settings, ...model.catalogs.values, definitions,
    ...(styles ? { nativeStyleUnknownFields: styles } : {}),
    ...(scenes ? { nativeSceneUnknownFields: scenes } : {}),
    ...(images ? { nativeImageUnknownFields: images } : {}),
    ...(materials ? { nativeMaterialUnknownFields: materials } : {}),
    ...(tags ? { nativeTagUnknownFields: tags } : {}),
    ...(hasSettings ? { nativeSettingsUnknownFields: settings } : {}),
    ...(model.rootExtensions.length ? { nativeRootUnknownFields: model.rootExtensions } : {}) };
}

function attachEnvelope(owner: Body | Sketch | MeshPart, extra: { required?: boolean; envelopeUnknown?: Uint8Array[] } | undefined): void {
  if (extra?.required === false || extra?.envelopeUnknown?.length) owner.nativeUnknownFields = {
    ...owner.nativeUnknownFields,
    ...(extra.required === false ? { required: false } : {}),
    ...(extra.envelopeUnknown?.length ? { envelopeUnknown: extra.envelopeUnknown } : {}),
  };
}
