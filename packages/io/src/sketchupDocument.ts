// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  MERGE_TOL, newGuid, planeBasis, v3dot,
  type CurveId, type DefId, type FaceLocalId, type Guid, type Id, type ImageId, type MaterialId, type PlaneBasis, type SceneId,
  type Mat4, type StyleId, type SurfaceId, type TagFolderId, type TagId, type Vec3,
  M4_IDENTITY, m4mul, m4translation,
} from '@pushform/core';
import {
  allocId, bodyFromMesh, createDefaultStyle, createEntityContainer, DEFAULT_AXES, DEFAULT_BEHAVIORS, DEFAULT_SCENE_FLAGS,
  newImageEntity, overlapRatio, UV_AUTO,
  type CameraState, type ComponentDefinition, type ComponentInstance, type Curve, type DocumentDraft, type Draft, type EdgeRecord,
  type EntityContainer, type ImageAsset, type ImageStore, type LoopRef, type Sketch, type SketchEdge, type Style, type UvMapping, validateMeshPartGeometry, MAX_DOCUMENT_MESH_PART_TRIANGLES, type MeshPartGeometry } from '@pushform/model';
import { cellKey } from '@pushform/geom';
import type {
  ImportedCurve, ImportedDefinition, ImportedDisplay, ImportedEdgeFlags, ImportedFace, ImportedScene, ImportedUvMap, ModelImportReport, SketchUpImport,
} from './sketchup';

/** Style settings read from a file, with their colors copied, so a document never shares arrays with the import. */
function copyDisplay(display: ImportedDisplay): ImportedDisplay {
  const copy = <T extends object>(group: Partial<T>): Partial<T> =>
    Object.fromEntries(Object.entries(group).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])) as Partial<T>;
  return { edges: copy(display.edges), faces: copy(display.faces), background: copy(display.background), modeling: copy(display.modeling) };
}

/**
 * A side's texture placement as a mapping from the face basis (u, v) in meters: to tiles (affine, or projective for a
 * distorted placement), or to texture-frame meters for a sized one.
 */
function uvMapping(map: ImportedUvMap, basis: PlaneBasis): UvMapping {
  const at = (axis: ImportedUvMap['s']): [number, number, number] => [
    v3dot([axis[0], axis[1], axis[2]], basis.u), v3dot([axis[0], axis[1], axis[2]], basis.v),
    v3dot([axis[0], axis[1], axis[2]], basis.origin) + axis[3]];
  if (map.q) return { kind: 'projective', matrix: [...at(map.s), ...at(map.t), ...at(map.q)] };
  return { kind: map.sized ? 'sized' : 'affine', matrix: [...at(map.s), ...at(map.t)] };
}

/** `uv` and, where the back differs from the front, `uvBack` of an imported face in `basis`. */
function faceUv(face: ImportedFace, basis: PlaneBasis): { uv: UvMapping; uvBack?: UvMapping } {
  const uv = face.frontUv ? uvMapping(face.frontUv, basis) : UV_AUTO;
  if (face.backUv) return { uv, uvBack: uvMapping(face.backUv, basis) };
  return face.frontUv ? { uv, uvBack: UV_AUTO } : { uv };
}

/**
 * Call inside one transaction. All imported identities belong to the destination document.
 * Texture images become document image assets; their bytes are registered in `images` (the
 * destination's `DocumentHost.images`), which is not undoable, like other runtime image bytes.
 */
export function applySketchUpImport(
  draft: DocumentDraft, scene: SketchUpImport,
  options: { definitionId?: DefId; groupName?: string; images?: ImageStore;
    /** Scene material keys that stand for materials the document already has, which are reused rather than created. */
    materialIds?: ReadonlyMap<number, MaterialId> } = {},
): ModelImportReport {
  // Map boundary cast avoids immer's recursive tuple mutability instantiation.
  const destination = draft.definitions as unknown as Map<DefId, ComponentDefinition>;
  const target = destination.get(options.definitionId ?? draft.rootDefinitionId);
  if (!target) throw new Error('The SketchUp import destination no longer exists.');
  const report: ModelImportReport = { bodies: 0, sheetFaces: 0, looseEdges: 0,
    definitions: 0, instances: 0, materials: 0, tags: 0, scenes: 0, sectionPlanes: 0, guides: 0, dimensions: 0, texts: 0,
    meshParts: 0, meshPartTriangles: 0, warnings: [...scene.warnings], format: scene.format?.name };
  const materials = new Map<number, MaterialId>(), tags = new Map<string, TagId>();
  const assets = draft.images as unknown as Map<ImageId, ImageAsset>;
  const imageIds = scene.images.map(image => {
    // Reuse an identical image the destination already holds the bytes of.
    for (const asset of assets.values())
      if (asset.sha256 === image.sha256 && options.images?.has(asset.id)) return asset.id;
    const id = allocId<ImageId>(draft);
    const asset: ImageAsset = { id, name: image.name, mime: image.mime, width: image.width, height: image.height, sha256: image.sha256 };
    assets.set(id, asset);
    options.images?.register(asset, image.bytes, image.mime);
    return id;
  });
  for (const [key, m] of scene.materials) {
    const existing = options.materialIds?.get(key);
    if (existing !== undefined && draft.materials.has(existing)) { materials.set(key, existing); continue; }
    const id = allocId<MaterialId>(draft);
    // A colorized texture keeps its image and colorizes toward the material color when drawn.
    draft.materials.set(id, { id, name: m.name, color: [...m.color], alpha: m.alpha, texture: m.texture
      ? { imageId: imageIds[m.texture.image]!, widthM: m.texture.widthM, heightM: m.texture.heightM,
        colorize: !!m.texture.colorize, ...(m.texture.colorize ? { colorizeType: m.texture.colorize } : {}) } : null });
    materials.set(key, id); report.materials++;
  }
  // Tag folders first, so tags and subfolders can refer to them.
  const folderIds = (scene.tagFolders ?? []).map(() => allocId<TagFolderId>(draft));
  (scene.tagFolders ?? []).forEach((folder, i) => draft.tagFolders.set(folderIds[i]!, { id: folderIds[i]!, name: folder.name,
    visible: folder.visible, parentId: folder.parent === null ? null : folderIds[folder.parent] ?? null }));
  for (const tag of scene.tags) {
    if (/^(Layer0|Untagged)$/i.test(tag.name)) { tags.set(tag.name, draft.defaultTagId); continue; }
    const id = allocId<TagId>(draft);
    draft.tags.set(id, { id, name: tag.name, color: [...tag.color], visible: tag.visible,
      folderId: tag.folder === undefined || tag.folder === null ? null : folderIds[tag.folder] ?? null, dashes: null });
    tags.set(tag.name, id); report.tags++;
  }
  // Scene tag lists and text/instance tag references drop the trailing spaces some tag names have,
  // so match on trimmed names too. A name that trims to nothing is no tag (Untagged): it must not
  // match a tag named only with spaces, which may be hidden.
  const trimmedTags = new Map([...tags].filter(([name]) => name.trim()).map(([name, id]) => [name.trim(), id]));
  const tagFor = (name: string): TagId | undefined => tags.get(name) ?? (name.trim() ? trimmedTags.get(name.trim()) : undefined);
  const material = (key: number | null): MaterialId | null => key === null ? null : materials.get(key) ?? null;
  const common = () => ({ tagId: draft.defaultTagId, hidden: false, locked: false,
    castShadows: true, receiveShadows: true, attributes: {} });
  const definitions = new Map<number, DefId>();
  const usedGuids = new Set([...draft.definitions.values()].map(d => d.guid));
  const createDefinition = (source: ImportedDefinition, isGroup = false): DefId => {
    const id = allocId<DefId>(draft);
    const guid = source.guid && source.guid !== 'ROOT' && !usedGuids.has(source.guid as Guid)
      ? source.guid as Guid : newGuid();
    usedGuids.add(guid);
    const def: ComponentDefinition = { id, guid, name: source.name || 'Imported component', description: '', isGroup,
      axes: DEFAULT_AXES, behaviors: { ...DEFAULT_BEHAVIORS,
        alwaysFaceCamera: source.alwaysFaceCamera, shadowsFaceSun: source.shadowsFaceSun },
      entities: createEntityContainer(), bounds: null };
    destination.set(id, def); definitions.set(source.key, id); report.definitions++;
    return id;
  };
  // A SketchUp image with a picture becomes an image entity wherever it is placed, so it needs no definition.
  const pictureImage = (source: ImportedDefinition | undefined): ImageId | null => {
    const texture = source?.picture ? scene.materials.get(source.picture.material)?.texture : null;
    return texture ? imageIds[texture.image] ?? null : null;
  };
  for (const source of scene.definitions.values()) if (pictureImage(source) === null) createDefinition(source, source.group);
  let rootId = target.id;
  if (options.groupName !== undefined) {
    rootId = createDefinition({ ...scene.root, name: options.groupName }, true);
    const id = allocId<Id>(draft);
    const instance: ComponentInstance = { ...common(), id, definitionId: rootId,
      transform: M4_IDENTITY, name: options.groupName, materialId: null };
    target.entities.instances.set(id, instance); target.entities.order.push(id); report.instances++;
  }
  // A curve keeps its record only when every one of its edges maps onto a body edge (or sketch edge) of its own.
  let droppedBodyCurves = 0, droppedSketchCurves = 0;
  const curveRecord = (c: ImportedCurve, edgeRefs: Curve['edgeRefs']): Curve => ({ id: allocId<CurveId>(draft), kind: c.kind,
    center: [...c.center], normal: [...c.normal], radius: c.radius, startAngle: c.startAngle, endAngle: c.endAngle,
    segments: c.segments, edgeRefs });
  // Mesh parts of every definition count against the document's limit together.
  let meshPartTriangles = 0;
  for (const def of draft.definitions.values()) for (const part of def.entities.meshParts.values()) meshPartTriangles += part.geometry.triangles.length / 3;
  const populate = (source: ImportedDefinition, id: DefId): void => {
    const container = destination.get(id)!.entities;
    for (const part of source.meshParts ?? []) {
      const faceMaterials = new Uint32Array(part.geometry.faceCount);
      part.faceMaterialKeys.forEach((key, face) => { faceMaterials[face] = key < 0 ? 0 : material(key) ?? 0; });
      const geometry: MeshPartGeometry = { ...part.geometry, faceMaterials };
      validateMeshPartGeometry(geometry);
      meshPartTriangles += geometry.triangles.length / 3;
      if (meshPartTriangles > MAX_DOCUMENT_MESH_PART_TRIANGLES)
        throw new Error(`The model would hold more than ${MAX_DOCUMENT_MESH_PART_TRIANGLES.toLocaleString('en-US')} triangles of mesh parts.`);
      const partId = allocId<Id>(draft);
      container.meshParts.set(partId, { ...common(), id: partId, name: part.name, source: part.source, geometry, materialId: part.material === null || part.material === undefined ? null : material(part.material) } as never);
      container.order.push(partId);
      report.meshParts = (report.meshParts ?? 0) + 1;
      report.meshPartTriangles = (report.meshPartTriangles ?? 0) + geometry.triangles.length / 3;
    }
    for (const [index, solid] of source.solids.entries()) {
      const body = bodyFromMesh(draft, solid.mesh, { container: container as unknown as Draft<EntityContainer>, weldTol: MERGE_TOL });
      const byId = new Map(solid.faces.map(f => [f.id, f]));
      for (const [faceId, face] of body.faces) {
        const original = byId.get(faceId);
        if (!original) continue;
        face.frontMaterialId = material(original.front); face.backMaterialId = material(original.back);
        face.hidden = original.hidden;
        if (original.tag) face.tagId = tagFor(original.tag) ?? draft.defaultTagId;
        Object.assign(face, faceUv(original, face.basis));
      }
      // Body edge runs of each source curve, and the source edges they cover.
      const curveRuns = new Map<number, { records: EdgeRecord[]; edges: Set<number>; merged: boolean }>();
      const segmentIndexes = new Map<number, SourceSegmentIndex>();
      for (const edge of body.edges.values()) {
        const face = byId.get(edge.faceA);
        if (!face) continue;
        const index = segmentIndexes.get(face.id) ?? segmentIndexes.set(face.id, new SourceSegmentIndex(face, MERGE_TOL)).get(face.id)!;
        const matches = index.matches(edge.polyline);
        if (matches.reduce((sum, m) => sum + m.overlap, 0) < 1 - 1e-6) continue;
        edge.soft = matches.every(m => m.flags.soft);
        edge.smooth = matches.every(m => m.flags.smooth);
        edge.hidden = matches.every(m => m.flags.hidden);
        // A body edge made of several source edges keeps their tag when they share one.
        const tag = matches[0]!.flags.tag;
        if (tag && matches.every(m => m.flags.tag === tag)) edge.tagId = tagFor(tag) ?? draft.defaultTagId;
        const curve = matches[0]!.flags.curve;
        if (curve === null || !matches.every(m => m.flags.curve === curve)) continue;
        const run = curveRuns.get(curve) ?? curveRuns.set(curve, { records: [], edges: new Set(), merged: false }).get(curve)!;
        run.records.push(edge as unknown as EdgeRecord);
        for (const m of matches) run.edges.add(m.flags.edge);
        // Collinear curve edges that the body merged into one edge do not each have a body edge of their own.
        if (new Set(matches.map(m => m.flags.edge)).size > 1) run.merged = true;
      }
      for (const c of source.curves) if (c.home === index) {
        const run = curveRuns.get(c.source);
        if (!run || run.merged || run.edges.size !== c.edges.length) { droppedBodyCurves++; continue; }
        const record = curveRecord(c, run.records.map(r => r.key));
        for (const r of run.records) r.curveId = record.id;
        body.curves.set(record.id, record);
      }
      // Smooth flags control shading as well as edge display. Native surfaces supply shared normals.
      const faceGroups = new Map<FaceLocalId, FaceLocalId>([...body.faces.keys()].map(fid => [fid, fid]));
      const find = (fid: FaceLocalId): FaceLocalId => {
        let root = fid;
        while (faceGroups.get(root) !== root) root = faceGroups.get(root)!;
        while (faceGroups.get(fid) !== fid) { const next = faceGroups.get(fid)!; faceGroups.set(fid, root); fid = next; }
        return root;
      };
      for (const e of body.edges.values()) if (e.smooth) faceGroups.set(find(e.faceA), find(e.faceB));
      const groups = new Map<FaceLocalId, FaceLocalId[]>();
      for (const fid of body.faces.keys()) {
        const root = find(fid); (groups.get(root) ?? groups.set(root, []).get(root)!).push(fid);
      }
      for (const faceIds of groups.values()) if (faceIds.length > 1) {
        const surfaceId = allocId<SurfaceId>(draft);
        body.surfaces.set(surfaceId, { id: surfaceId, faceIds, curveId: null });
        for (const fid of faceIds) body.faces.get(fid)!.surfaceId = surfaceId;
      }
      report.bodies++;
    }
    const sketch = container.sketch as unknown as Sketch;
    // Preserve sheet coordinates even when solid validation welded a small edge away. Using the
    // editing graph's proximity merge here would collapse that edge and abort an otherwise useful import.
    const vertices = new Map<string, Id>();
    const addVertex = (p: Vec3): Id => {
      const key = p.join(','), existing = vertices.get(key);
      if (existing !== undefined) return existing;
      const vertexId = allocId<Id>(draft);
      sketch.vertices.set(vertexId, { id: vertexId, p: [...p] }); vertices.set(key, vertexId);
      const cell = cellKey(p, MERGE_TOL), bucket = sketch.vertexHash.get(cell);
      if (bucket) bucket.push(vertexId); else sketch.vertexHash.set(cell, [vertexId]);
      return vertexId;
    };
    // A source edge cut where a face's outline crosses it becomes several sketch edges.
    const sketchEdges = new Map<string, SketchEdge>(), fromSource = new Map<number, Set<Id>>();
    const addEdge = (a: Vec3, b: Vec3, { soft, smooth, hidden, edge: sourceEdge, tag }: ImportedEdgeFlags): LoopRef => {
      const va = addVertex(a), vb = addVertex(b);
      if (va === vb) throw new Error('A SketchUp sheet edge has coincident endpoints.');
      const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
      let edge = sketchEdges.get(key);
      if (!edge) {
        const id = allocId<Id>(draft);
        edge = { ...common(), soft, smooth, hidden, id, a: va, b: vb, curveId: null, ...(tag ? { tagId: tagFor(tag) ?? draft.defaultTagId } : {}) };
        sketch.edges.set(id, edge); sketchEdges.set(key, edge);
      }
      (fromSource.get(sourceEdge) ?? fromSource.set(sourceEdge, new Set()).get(sourceEdge)!).add(edge.id);
      return { edgeId: edge.id, forward: edge.a === va };
    };
    for (const face of source.sheets) {
      const loops = face.loops.map((loop, k) => loop.map((p, i) => addEdge(p, loop[(i + 1) % loop.length]!, face.edgeFlags[k]![i]!)));
      const faceId = allocId<Id>(draft), d = -v3dot(face.normal, face.loops[0]![0]!);
      // Basis through the plane's point nearest the origin, like body faces, so the automatic
      // texture mapping agrees with the placement of imported textures.
      const basis = planeBasis([-face.normal[0] * d, -face.normal[1] * d, -face.normal[2] * d], face.normal);
      sketch.faces.set(faceId, { ...common(), id: faceId, ...(face.tag ? { tagId: tagFor(face.tag) ?? draft.defaultTagId } : {}),
        hidden: face.hidden, plane: { n: face.normal, d }, basis, loops,
        frontMaterialId: material(face.front), backMaterialId: material(face.back), ...faceUv(face, basis) });
      report.sheetFaces++;
    }
    for (const edge of source.edges) { addEdge(edge.a, edge.b, edge); report.looseEdges++; }
    for (const c of source.curves) if (c.home === 'sketch') {
      const ids = c.edges.map(e => fromSource.get(e));
      if (ids.some(e => e === undefined)) { droppedSketchCurves++; continue; }
      const refs = [...new Set(ids.flatMap(e => [...e!]))];
      // A freehand curve has one segment per sketch edge; a cut part bounding no shaded area was not imported.
      const record = curveRecord(c.kind === 'freehand' ? { ...c, segments: refs.length } : c, refs);
      for (const e of record.edgeRefs) sketch.edges.get(e as Id)!.curveId = record.id;
      sketch.curves.set(record.id, record);
    }

    // Annotations draw no shadows; the definition keeps at most one active section plane.
    const annotation = (hidden: boolean, tag: string) => ({ ...common(), castShadows: false, receiveShadows: false,
      hidden, tagId: tagFor(tag) ?? draft.defaultTagId });
    for (const plane of source.sectionPlanes) {
      const planeId = allocId<Id>(draft);
      container.sectionPlanes.set(planeId, { ...annotation(plane.hidden, plane.tag), id: planeId, name: plane.name, symbol: plane.symbol,
        plane: { n: [...plane.plane.n], d: plane.plane.d }, origin: [...plane.origin] });
      if (plane.active) container.activeSectionPlaneId = planeId;
      container.order.push(planeId); report.sectionPlanes++;
    }
    for (const guide of source.guides) {
      const guideId = allocId<Id>(draft), attrs = { ...annotation(guide.hidden, guide.tag), id: guideId };
      container.guides.set(guideId, guide.kind === 'line' ? { ...attrs, kind: 'line', origin: [...guide.origin], dir: [...guide.dir] }
        : guide.kind === 'segment' ? { ...attrs, kind: 'segment', origin: [...guide.origin], end: [...guide.end] }
          : { ...attrs, kind: 'point', origin: [...guide.origin] });
      container.order.push(guideId); report.guides++;
    }
    for (const dim of source.dimensions) {
      const dimensionId = allocId<Id>(draft);
      container.dimensions.set(dimensionId, { ...annotation(dim.hidden, dim.tag), id: dimensionId, kind: 'linear',
        start: [...dim.start], end: [...dim.end], offset: [...dim.offset], normal: [...dim.normal], text: dim.text,
        fontSizePt: DIMENSION_FONT_PT });
      container.order.push(dimensionId); report.dimensions++;
    }

    for (const text of source.texts) {
      const textId = allocId<Id>(draft);
      container.texts.set(textId, { ...common(), id: textId, hidden: text.hidden, tagId: tagFor(text.tag) ?? draft.defaultTagId,
        text: text.text, kind: text.kind, position: [...text.position], offset: text.offset && [...text.offset], leader: text.leader,
        ...(text.viewOffset ? { viewOffset: [...text.viewOffset] as [number, number] } : {}),
        // The file's font and the material's color; Arial 12 pt black where the file does not record them.
        fontFamily: text.font?.family ?? IMPORTED_TEXT_FONT.family, fontSizePt: text.font?.sizePt ?? IMPORTED_TEXT_FONT.sizePt,
        ...(text.font?.bold ? { bold: true } : {}), ...(text.font?.italic ? { italic: true } : {}),
        color: text.color ? [text.color[0], text.color[1], text.color[2]] : IMPORTED_TEXT_FONT.color,
        ...(text.arrow ? { arrow: text.arrow } : {}) });
      container.order.push(textId); report.texts++;
    }
    for (const inst of source.instances) {
      const placed = scene.definitions.get(inst.definition);
      const imageId = pictureImage(placed);
      if (imageId !== null && placed?.picture) {
        const entityId = allocId<Id>(draft);
        const { origin, widthM, heightM } = placed.picture;
        container.images.set(entityId, { ...newImageEntity(entityId, imageId, m4mul(inst.transform, m4translation(origin)) as unknown as Mat4, widthM, heightM,
          tagFor(inst.tag) ?? draft.defaultTagId), hidden: inst.hidden });
        container.order.push(entityId); report.images = (report.images ?? 0) + 1;
        continue;
      }
      const definitionId = definitions.get(inst.definition);
      if (definitionId === undefined) throw new Error('Missing prepared SketchUp definition.');
      const instanceId = allocId<Id>(draft);
      container.instances.set(instanceId, { ...common(), id: instanceId, definitionId,
        name: inst.name, transform: inst.transform, hidden: inst.hidden, materialId: material(inst.material),
        tagId: tagFor(inst.tag) ?? draft.defaultTagId,
        attributes: Object.keys(inst.properties).length ? { dynamic_attributes: inst.properties } : {} });
      container.order.push(instanceId); report.instances++;
    }
    destination.get(id)!.bounds = null;
  };
  for (const source of scene.definitions.values()) { const id = definitions.get(source.key); if (id !== undefined) populate(source, id); }
  populate(scene.root, rootId);
  if (droppedBodyCurves) report.warnings.push(`${droppedBodyCurves} curve(s) on solids imported as separate edges: some of their edges do not map onto solid edges of their own, as when one continues straight into another edge.`);
  if (droppedSketchCurves) report.warnings.push(`${droppedSketchCurves} curve(s) imported as separate edges: some of their edges are missing from the imported sheets and loose edges.`);
  const sceneTag = (name: string): TagId[] => {
    const id = tagFor(name);
    return id === undefined ? [] : [id];
  };
  // Display units belong to the opened model; importing into another model keeps the destination's units.
  if (options.groupName === undefined && scene.units) draft.meta.units = { ...scene.units };
  // An opened file keeps its own Display Section Planes and Display Section Cuts. A file that records neither and holds
  // section planes starts with them hidden, as authors often hide them, and its active cuts showing.
  if (options.groupName === undefined) {
    const style = draft.styles.get(draft.activeStyleId);
    if (style && scene.sectionDisplay) {
      style.modeling.sectionPlanesVisible = scene.sectionDisplay.planes;
      style.modeling.sectionCutsVisible = scene.sectionDisplay.cuts;
    } else if (style && report.sectionPlanes > 0) style.modeling.sectionPlanesVisible = false;
    // The model opens in its own style: the settings the file records replace the active style's.
    if (style && scene.display) {
      const settings = copyDisplay(scene.display);
      Object.assign(style.edges, settings.edges); Object.assign(style.faces, settings.faces);
      Object.assign(style.background, settings.background); Object.assign(style.modeling, settings.modeling);
    }
  }
  // Saved scenes belong to the opened model; importing into another model leaves its scenes alone.
  if (options.groupName === undefined) {
    // A scene that saved its style gets the model's style when the settings are the same, else a style of its own,
    // shared by scenes that saved the same settings.
    const styleFor = (display: ImportedDisplay) => copyDisplay(display);
    const modelKey = scene.display ? JSON.stringify(styleFor(scene.display)) : null;
    const sceneStyles = new Map<string, StyleId>();
    const styleOf = (saved: ImportedScene): StyleId | null => {
      if (!saved.display) return null;
      const settings = styleFor(saved.display), key = JSON.stringify(settings);
      if (key === modelKey) return draft.activeStyleId;
      const existing = sceneStyles.get(key);
      if (existing !== undefined) return existing;
      const id = allocId<StyleId>(draft);
      const style = createDefaultStyle(id);
      style.name = `${saved.name} style`; style.description = `The style scene "${saved.name}" saved in the SketchUp file.`;
      Object.assign(style.edges, settings.edges); Object.assign(style.faces, settings.faces);
      Object.assign(style.background, settings.background); Object.assign(style.modeling, settings.modeling);
      draft.styles.set(id, style as Draft<Style>); sceneStyles.set(key, id);
      return id;
    };
    for (const saved of scene.scenes) {
      const id = allocId<SceneId>(draft);
      const styleId = styleOf(saved);
      draft.scenes.set(id, { id, name: saved.name, description: '',
        camera: ((camera: CameraState) => ({ ...camera, eye: [...camera.eye], target: [...camera.target], up: [...camera.up] }))(saved.camera ?? DEFAULT_SCENE_CAMERA),
        // The reader recovers each scene's camera, hidden tags and saved style; the scene leaves everything else as it is.
        flags: { ...DEFAULT_SCENE_FLAGS, useCamera: saved.camera !== null, useTags: saved.usesTags, useHiddenGeometry: false, useHiddenObjects: false,
          useStyle: styleId !== null, useShadows: false, useSectionPlanes: false, useAxes: false },
        hiddenEntities: [], hiddenTags: saved.usesTags ? [...new Set(saved.hiddenTags.flatMap(sceneTag))] : [],
        hiddenTagFolders: [], styleId, shadows: null, activeSectionPlanes: [], axesVisible: true, includeInAnimation: true });
      draft.sceneOrder.push(id); report.scenes++;
    }
  }
  return report;
}

/** A source face segment that a body edge covers in part or whole, with the fraction of the edge it covers. */
export interface SourceSegmentMatch { overlap: number; flags: ImportedEdgeFlags }

/**
 * The boundary segments of one imported face, bucketed by the grid cells their tolerance-expanded
 * boxes cover, so matching a body edge tests only the segments near it instead of the whole boundary.
 * A face with thousands of boundary edges (a site outline, a high-segment circle) otherwise costs a
 * segment scan per body edge, which is quadratic in its edge count.
 *
 * Results equal the exhaustive scan: a segment `overlapRatio()` accepts lies within the tolerance of
 * the edge, so its expanded box intersects the edge's and they share at least one cell. Matches keep
 * loop order, then segment order within the loop.
 */
export class SourceSegmentIndex {
  private readonly starts: Vec3[] = [];
  private readonly ends: Vec3[] = [];
  private readonly flags: ImportedEdgeFlags[] = [];
  /** Null when the face has too few segments for bucketing to pay off; every segment is a candidate then. */
  private readonly cells: Map<string, number[]> | null;
  private readonly cellSize: number = 1;

  constructor(face: ImportedFace, private readonly tol: number) {
    let total = 0;
    face.loops.forEach((loop, k) => loop.forEach((p, j) => {
      const q = loop[(j + 1) % loop.length]!;
      this.starts.push(p); this.ends.push(q); this.flags.push(face.edgeFlags[k]![j]!);
      total += Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1]), Math.abs(q[2] - p[2]));
    }));
    if (this.starts.length <= SourceSegmentIndex.SMALL_FACE) { this.cells = null; return; }
    // Cells about one typical segment long keep both the per-segment cell count and the candidates per query small.
    this.cellSize = Math.max(total / this.starts.length, tol * 16);
    this.cells = new Map();
    for (let i = 0; i < this.starts.length; i++)
      this.visitCells(this.starts[i]!, this.ends[i]!, key => { const bucket = this.cells!.get(key); if (bucket) bucket.push(i); else this.cells!.set(key, [i]); });
  }

  /** The source segments `polyline` covers, as the exhaustive scan over every loop segment reports them. */
  matches(polyline: Vec3[]): SourceSegmentMatch[] {
    const a = polyline[0]!, b = polyline[polyline.length - 1]!;
    let candidates: Iterable<number>;
    if (!this.cells) candidates = this.starts.keys();
    else {
      const found = new Set<number>();
      this.visitCells(a, b, key => { for (const i of this.cells!.get(key) ?? []) found.add(i); });
      candidates = [...found].sort((x, y) => x - y);
    }
    const matches: SourceSegmentMatch[] = [];
    for (const i of candidates) {
      const overlap = overlapRatio(polyline, [this.starts[i]!, this.ends[i]!], this.tol);
      if (overlap > 0) matches.push({ overlap, flags: this.flags[i]! });
    }
    return matches;
  }

  /** Faces at or below this many boundary segments are scanned exhaustively. */
  static readonly SMALL_FACE = 8;

  /** Every cell the box of segment p–q, grown by the tolerance, touches. */
  /**
   * Visit the cells along the segment, walking it in cell-sized steps so a long diagonal costs
   * O(length / cell) rather than the full O((length / cell)^3) box. Every point of the segment, grown
   * by the tolerance, lies in some step's sub-box, so two segments within tolerance still share a cell.
   */
  private visitCells(p: Vec3, q: Vec3, visit: (key: string) => void): void {
    const span = Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1]), Math.abs(q[2] - p[2]));
    const steps = Math.max(1, Math.ceil(span / this.cellSize));
    const seen = new Set<string>();
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps, t1 = (s + 1) / steps;
      for (let axis = 0; axis < 3; axis++) {
        const a = p[axis]! + (q[axis]! - p[axis]!) * t0, b = p[axis]! + (q[axis]! - p[axis]!) * t1;
        lo[axis] = Math.floor((Math.min(a, b) - this.tol) / this.cellSize);
        hi[axis] = Math.floor((Math.max(a, b) + this.tol) / this.cellSize);
      }
      for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (let z = lo[2]!; z <= hi[2]!; z++) {
        const key = `${x},${y},${z}`;
        if (!seen.has(key)) { seen.add(key); visit(key); }
      }
    }
  }
}

/** The reader recovers no dimension font, so imported dimensions use PushForm's default dimension text size. */
const DIMENSION_FONT_PT = 10;
/** Imported text uses one fixed style: the reader does not recover fonts or text colors. */
const IMPORTED_TEXT_FONT = { family: 'Arial', sizePt: 12, color: [0, 0, 0] as const };

/** Camera kept by a scene whose saved camera the reader could not recover; its useCamera flag is off. */
const DEFAULT_SCENE_CAMERA: CameraState = { eye: [4.5, -6.6, 1.9], target: [0, 0, 0.9], up: [0, 0, 1], perspective: true, fov: 35, height: 10 };
