// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  ANGLE_TOL, AREA_TOL, LENGTH_TOL, MERGE_TOL, RATIO_TOL, SKETCHUP_VERTICAL_TEXTURE_TOL, TRIANGULATION_AREA_TOL, basisToLocal, planeBasis,
  v3add, v3cross, v3dist, v3dot, v3len, v3normalize, v3scale, v3sub, DEFAULT_UNITS,
  type LengthFormat, type LengthUnit, type Mat4, type MeshData, type Plane, type UnitSettings, type Vec3,
} from '@pushform/core';
import { tessellateCurve, triangulatePlanarFace, weldVertices } from '@pushform/geom';
import { meshTopologyProblems } from '@pushform/kernel';
import { addThroughSplits, insertSplits, shadedRegion, splitSegment, type FacePiece, type ShadedRegion } from './sketchupCrossingFaces';
import type { BackgroundStyle, CurveKind, EdgeStyle, EdgeStyleMode, FaceStyle, FaceStyleMode, ModelingColors, MeshPartGeometry, MeshPartSource } from '@pushform/model';
import { fastHash, hashImageBytes, imageSizeFromHeader } from '@pushform/model';
import { TiffError, tiffToPng } from './tiff';
import type {
  ConstructionLine, ConstructionPoint, Definition, Dimension, Edge, Face, SectionPlane, SkpModel,
} from 'openskp';

// Fields PushForm's reader patch adds (patches/openskp@1.3.0.patch): tags, hidden guides, the active
// section plane, and what a dimension measures (0 its points' distance, 1 along planeX, 2 across it).
type ReaderSectionPlane = SectionPlane & { layer?: string; active?: boolean };
type ReaderGuideLine = ConstructionLine & { hidden?: boolean; layer?: string };
type ReaderGuidePoint = ConstructionPoint & { hidden?: boolean; layer?: string };
type ReaderDimension = Dimension & { layer?: string; alignment?: number | null };

export const MAX_SKETCHUP_BYTES = 128 * 1024 * 1024;
const INCH = 0.0254;

/** Curve and group fields added by PushForm's reader patch (patches/openskp@1.3.0.patch). */
interface ReaderCurve {
  id: number;
  /** Number of edges SketchUp records for the curve. */
  edges: number;
  polygon: boolean;
  /** Arc, circle or polygon geometry in inches, angles about `normal` from `xaxis`; null for a polyline curve. */
  arc: { center: Vec3; normal: Vec3; xaxis: Vec3; yaxis: Vec3; startAngle: number; endAngle: number } | null;
}
type ReaderEdge = Edge & { curve?: number | null; layer?: string };
type ReaderDefinition = Definition & { isGroup?: boolean; curves?: ReaderCurve[] };
// Tag folders of 2021+ files (PushForm's reader patch): each tag's folder, and the folders with their parents.
type ReaderLayer = SkpModel['layers'][number] & { folder?: number | null };
type ReaderModel = SkpModel & { tagFolders?: { name: string; hidden: boolean; parent: number | null }[] };

export interface ImportProgress { stage: string; current: number; total: number }
/** Display flags of one source edge, its source id, and the source curve it belongs to (null when none is kept). */
export interface ImportedEdgeFlags {
  soft: boolean; smooth: boolean; hidden: boolean; edge: number; curve: number | null;
  /** The edge's own tag by name (SketchUp tags, DXF layers); absent means Untagged. */
  tag?: string;
}
/**
 * Texture coordinates of one face side, in tiles, as linear functions of a definition-local point
 * p in meters: s = s[0..2]·p + s[3], t = t[0..2]·p + t[3]. Only meaningful on the face's plane.
 */
/**
 * A side's texture placement as plane functions of the world point p: s = s·[p, 1], t = t·[p, 1] in tiles. A
 * distorted placement adds q and shows (s/q, t/q); a `sized` one gives s and t in meters, divided by the size of the
 * texture the side shows (the placement of an inherited texture, whatever its size).
 */
export interface ImportedUvMap {
  s: [number, number, number, number];
  t: [number, number, number, number];
  q?: [number, number, number, number];
  sized?: true;
}
export interface ImportedFace {
  id: number;
  sourceId: number;
  loops: Vec3[][];
  normal: Vec3;
  front: number | null;
  back: number | null;
  /** Side texture placement where SketchUp's differs from PushForm's automatic one; null = automatic. */
  frontUv: ImportedUvMap | null;
  backUv: ImportedUvMap | null;
  hidden: boolean;
  edgeFlags: ImportedEdgeFlags[][];
  /** The face's own tag by name; absent means Untagged. */
  tag?: string;
}
/** A texture image from the file; materials refer to it by index. */
export interface ImportedImage {
  name: string;
  mime: string;
  bytes: Uint8Array;
  /** Pixel size (0 when the header does not say). */
  width: number;
  height: number;
  /** Content hash (SHA-256 where WebCrypto is available). */
  sha256: string;
}
export interface ImportedMaterial {
  name: string;
  color: Vec3;
  alpha: number;
  /**
   * Texture image index and the size of one tile in meters, or null for a plain color. `colorize` is SketchUp's
   * colorize type when the texture is colorized toward the material color.
   */
  texture: { image: number; widthM: number; heightM: number; colorize?: 'shift' | 'tint' } | null;
}
export interface ImportedEdge extends ImportedEdgeFlags {
  a: Vec3; b: Vec3;
}
/**
 * A SketchUp curve kept as a PushForm curve, in meters. Arcs, circles and polygons whose vertices lie on their
 * tessellation keep that geometry; the rest (ellipses, edited arcs, polylines) become freehand curves.
 */
export interface ImportedCurve {
  source: number;
  kind: CurveKind;
  center: Vec3; normal: Vec3; radius: number; startAngle: number; endAngle: number; segments: number;
  /** Source edge ids in order along the curve; an edge cut where a face's outline crosses it is several sketch edges. */
  edges: number[];
  /** Where its edges are: the index of a solid in `solids`, or the sketch (sheets and loose edges). */
  home: number | 'sketch';
}
export interface ImportedSolid { mesh: MeshData; faces: ImportedFace[] }
/** A SketchUp text: leader text at a point (meters) with its label offset, or screen text at view fractions. */
export interface ImportedText {
  text: string;
  kind: 'screen' | 'leader';
  /** Anchor in the definition's coordinates (leader), or [x, y, 0] fractions of the view (screen). */
  position: Vec3;
  /** Label offset from the anchor in the definition's coordinates (pushpin leader), or null. */
  offset: Vec3 | null;
  leader: 'none' | 'view' | 'pushpin';
  hidden: boolean;
  tag: string;
  /** A view-based leader's label offset in meters along the view's right and up directions, shown or hidden. */
  viewOffset?: [number, number] | undefined;
  /** Face, point size, bold and italic, when the file records them. */
  font?: { family: string; sizePt: number; bold: boolean; italic: boolean } | undefined;
  /** The text's color: its material's (0–1 RGB), when it has one. */
  color?: Vec3 | undefined;
  /** The leader's arrow. */
  arrow?: TextArrow | undefined;
}
export type TextArrow = 'none' | 'slash' | 'dot' | 'closed' | 'open';
const TEXT_ARROWS: readonly TextArrow[] = ['none', 'slash', 'dot', 'closed', 'open'];
export interface ImportedDefinition {
  key: number;
  guid: string;
  name: string;
  alwaysFaceCamera: boolean;
  /** A SketchUp image: a component holding the rectangle its picture is drawn on as a texture. */
  image: boolean;
  /**
   * For an image whose geometry is one rectangle in its xy plane painted with a textured material: that material and
   * the rectangle in meters. Each placement of it is imported as an image entity rather than a component.
   */
  picture?: { material: number; origin: Vec3; widthM: number; heightM: number } | undefined;
  /** A SketchUp group rather than a component. */
  group: boolean;
  shadowsFaceSun: boolean;
  solids: ImportedSolid[];
  sheets: ImportedFace[];
  edges: ImportedEdge[];
  curves: ImportedCurve[];
  sectionPlanes: ImportedSectionPlane[];
  guides: ImportedGuide[];
  dimensions: ImportedDimension[];
  texts: ImportedText[];
  instances: {
    definition: number; name: string; transform: Mat4; material: number | null;
    hidden: boolean; tag: string; properties: Record<string, string>;
  }[];
  /** Display-only parts of a large import; absent for a model read as faces. */
  meshParts?: ImportedMeshPart[] | undefined;
}
/** A mesh part as read: its packed geometry with the reader's material key per source face (−1 = none). */
export interface ImportedMeshPart {
  name: string;
  source: MeshPartSource;
  /** `faceMaterials` is left zero; `faceMaterialKeys` maps each source face to the scene's material keys. */
  geometry: MeshPartGeometry;
  faceMaterialKeys: Int32Array;
}
/** Files whose meshes together hold more triangles than this import as mesh parts rather than faces. */
export const MESH_PART_THRESHOLD = 250_000;
/** Section planes, guides and dimensions keep the coordinates of the definition that holds them. */
export interface ImportedSectionPlane {
  name: string; symbol: string; plane: Plane; origin: Vec3; hidden: boolean; tag: string; active: boolean;
}
export type ImportedGuide = { hidden: boolean; tag: string } & (
  | { kind: 'line'; origin: Vec3; dir: Vec3 }
  | { kind: 'segment'; origin: Vec3; end: Vec3 }
  | { kind: 'point'; origin: Vec3 });
/** A linear dimension measuring start to end; the dimension line is offset from that segment by `offset`. */
export interface ImportedDimension {
  start: Vec3; end: Vec3; offset: Vec3; normal: Vec3; text: string | null; hidden: boolean; tag: string;
}
/** A saved SketchUp scene: its camera (when the file stores one) and the tags it hides, by name. */
export interface ImportedScene {
  name: string;
  camera: { eye: Vec3; target: Vec3; up: Vec3; perspective: boolean; fov: number; height: number } | null;
  hiddenTags: string[];
  /** False when the scene does not save tag visibility, so showing it leaves tags as they are. */
  usesTags: boolean;
  /** The style the scene saved, as PushForm style settings, when it saves its style; otherwise null. */
  display?: ImportedDisplay | null;
}
export interface SketchUpImport {
  version: string;
  root: ImportedDefinition;
  definitions: Map<number, ImportedDefinition>;
  materials: Map<number, ImportedMaterial>;
  images: ImportedImage[];
  /** Tags, each with its folder: an index into `tagFolders`, or null at the top level. */
  tags: { name: string; color: Vec3; visible: boolean; folder?: number | null }[];
  /** Tag folders (SketchUp 2021+), each with its parent folder's index or null at the top level. */
  tagFolders?: { name: string; visible: boolean; parent: number | null }[];
  scenes: ImportedScene[];
  /** The source model's display units, or null when the file stores none. Open adopts them; Import does not. */
  units: UnitSettings | null;
  /**
   * The source model's Display Section Planes and Display Section Cuts, or null when the file records neither.
   * Open adopts them; Import does not.
   */
  sectionDisplay?: { planes: boolean; cuts: boolean } | null;
  /**
   * The source model's current rendering options, as PushForm style settings, or
   * null when the file records none. Open gives them to the active style; Import does not.
   */
  display?: ImportedDisplay | null;
  warnings: string[];
  /** The format the model was read from; absent means SketchUp. */
  format?: ImportFormat | undefined;
}
/** Style settings read from a SketchUp file: each group holds only the settings the file records. */
export interface ImportedDisplay {
  edges: Partial<EdgeStyle>;
  faces: Partial<FaceStyle>;
  background: Partial<BackgroundStyle>;
  modeling: Partial<ModelingColors>;
}
/** A SketchUp rendering option as the reader patch returns it: a number, a flag, or an r, g, b, a color in 0..255. */
type RenderingOption = number | boolean | [number, number, number, number];

/**
 * SketchUp's rendering options → PushForm's style settings. `RenderMode` 0 is Wireframe, 1 Hidden Line
 * and 5 Monochrome; the other values are Shaded, with textures while `Texture` is on. `ModelTransparency` (X-ray)
 * makes the shaded, textured and monochrome styles X-ray. `EdgeDisplayMode` 0 hides edges. `EdgeColorMode` 0 colors
 * edges by material, 1 all the same, 2 by axis. `GroundTransparency` is a percentage. Watermarks, sketchy edges, fog
 * and the saved style list are not read.
 */
export function sketchUpDisplay(options: Record<string, RenderingOption> | null | undefined): ImportedDisplay | null {
  if (!options) return null;
  const flag = (key: string): boolean | undefined => typeof options[key] === 'boolean' ? options[key] as boolean : undefined;
  const count = (key: string): number | undefined => typeof options[key] === 'number' ? options[key] as number : undefined;
  const rgb = (key: string): Vec3 | undefined => {
    const color = options[key];
    return Array.isArray(color) ? [color[0] / 255, color[1] / 255, color[2] / 255] : undefined;
  };
  const recorded = <T extends object>(entries: [keyof T, T[keyof T] | undefined][]): Partial<T> =>
    Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as Partial<T>;
  const mode = count('RenderMode'), xray = flag('ModelTransparency'), textured = flag('Texture'), edgeColors = count('EdgeColorMode');
  const faceMode: FaceStyleMode | undefined = mode === undefined ? undefined : mode === 0 ? 'wireframe' : mode === 1 ? 'hiddenLine'
    : xray ? 'xray' : mode === 5 ? 'monochrome' : textured === false ? 'shaded' : 'shadedWithTextures';
  const edgeColorMode: EdgeStyleMode | undefined = edgeColors === 0 ? 'byMaterial' : edgeColors === 2 ? 'byAxis' : edgeColors === 1 ? 'allSame' : undefined;
  const edges = count('EdgeDisplayMode'), hideGuides = flag('HideConstructionGeometry'), groundTransparency = count('GroundTransparency');
  const display: ImportedDisplay = {
    edges: recorded<EdgeStyle>([
      ['edges', edges === undefined ? undefined : edges !== 0], ['profiles', flag('DrawSilhouettes')], ['profileWidth', count('SilhouetteWidth')],
      ['depthCue', flag('DrawDepthQue')], ['depthCueLevels', count('DepthQueWidth')], ['extension', flag('ExtendLines')],
      ['extensionLength', count('LineExtension')], ['endpoints', flag('DrawLineEnds')], ['endpointLength', count('LineEndWidth')],
      ['jitter', flag('JitterEdges')], ['backEdges', flag('DrawBackEdges')], ['color', rgb('ForegroundColor')], ['colorMode', edgeColorMode],
    ]),
    faces: recorded<FaceStyle>([['mode', faceMode], ['frontColor', rgb('FaceFrontColor')], ['backColor', rgb('FaceBackColor')]]),
    background: recorded<BackgroundStyle>([
      ['color', rgb('BackgroundColor')], ['sky', flag('DrawHorizon')], ['skyColor', rgb('SkyColor')], ['ground', flag('DrawGround')],
      ['groundColor', rgb('GroundColor')], ['groundTransparency', groundTransparency === undefined ? undefined : Math.min(1, Math.max(0, groundTransparency / 100))],
      ['showGroundFromBelow', flag('DrawUnderground')],
    ]),
    modeling: recorded<ModelingColors>([
      ['selected', rgb('HighlightColor')], ['locked', rgb('LockedColor')], ['guides', rgb('ConstructionColor')],
      ['inactiveSection', rgb('SectionInactiveColor')], ['activeSection', rgb('SectionActiveColor')], ['sectionFill', rgb('SectionDefaultFillColor')],
      ['sectionLine', rgb('SectionDefaultCutColor')], ['sectionLineWidth', count('SectionCutWidth')], ['sectionFillEnabled', flag('SectionCutFilled')],
      ['hiddenGeometry', flag('DrawHidden')], ['guidesVisible', hideGuides === undefined ? undefined : !hideGuides],
      ['modelAxesVisible', flag('DisplaySketchAxes')], ['colorByTag', flag('DisplayColorByLayer')],
    ]),
  };
  return Object.values(display).some(group => Object.keys(group).length) ? display : null;
}
/**
 * The source format a converted model came from: its name in messages, and the standing limitations every
 * import of it reports.
 */
export interface ImportFormat { kind: 'sketchup' | 'collada' | 'obj' | '3ds' | 'stl' | 'dxf' | 'gltf' | 'step'; name: string; notes: readonly string[] }
export const SKETCHUP_FORMAT: ImportFormat = { kind: 'sketchup', name: 'SketchUp', notes: [
  'SketchUp import: the model opens in its current style (face, edge, background and modeling settings); the saved style list, per-scene styles, watermarks, sketchy edges, fog, radial and diameter dimensions, and extension data are not imported.',
] };
export interface ModelImportReport {
  bodies: number; sheetFaces: number; looseEdges: number;
  definitions: number; instances: number; materials: number; tags: number; scenes: number;
  sectionPlanes: number; guides: number; dimensions: number; texts: number;
  /** Placed pictures (image entities). */
  images?: number | undefined;
  /** Mesh parts made and the triangles they hold. */
  meshParts?: number | undefined;
  meshPartTriangles?: number | undefined;
  warnings: string[];
  /** The name of the format the model was read from, such as SketchUp or OBJ. */
  format?: string | undefined;
}

export function isSketchUpModelFile(name: string): boolean { return /\.(skp|skb)$/i.test(name); }

/** OpenSKP's 12/13-value matrices are row-major 3x3 + translation in inches. */
export function sketchUpTransform(matrix: readonly number[]): Mat4 {
  let out: number[];
  if (matrix.length === 12 || matrix.length === 13) {
    out = [matrix[0]!, matrix[3]!, matrix[6]!, 0,
      matrix[1]!, matrix[4]!, matrix[7]!, 0,
      matrix[2]!, matrix[5]!, matrix[8]!, 0,
      matrix[9]! * INCH, matrix[10]! * INCH, matrix[11]! * INCH, 1];
  } else if (matrix.length === 16) {
    out = [...matrix];
    out[12] = out[12]! * INCH; out[13] = out[13]! * INCH; out[14] = out[14]! * INCH;
  } else throw new Error(`Unsupported instance transform (${matrix.length} values)`);
  if (!out.every(Number.isFinite) || out[3] !== 0 || out[7] !== 0 || out[11] !== 0 || out[15] !== 1)
    throw new Error('Invalid instance transform');
  const determinant = v3dot([out[0]!, out[1]!, out[2]!], v3cross(
    [out[4]!, out[5]!, out[6]!], [out[8]!, out[9]!, out[10]!]));
  if (Math.abs(determinant) < Number.EPSILON) throw new Error('Singular instance transform');
  return out as unknown as Mat4;
}

/** Parse and prepare off the UI thread. No document is mutated until this succeeds. */
export async function readSketchUp(bytes: Uint8Array, onProgress?: (p: ImportProgress) => void): Promise<SketchUpImport> {
  if (bytes.byteLength > MAX_SKETCHUP_BYTES) throw new Error('SketchUp files larger than 128 MiB are not supported yet.');
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 254 || bytes[2] !== 255 || bytes[3] !== 14)
    throw new Error('Not a SketchUp model: invalid file header.');
  const { parseSkp } = await import('openskp');
  let model: SkpModel;
  // The reader takes a whole ArrayBuffer; reuse the caller's when the bytes fill it (the import worker's always do), so a
  // file near the 128 MiB limit is not held twice (PF-23).
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer : new Uint8Array(bytes).buffer;
  try {
    model = parseSkp(buffer, onProgress ? {
      onProgress: p => onProgress({ ...p, stage: 'Reading SketchUp model' }),
    } : {});
  } catch (cause) {
    throw new Error(`Could not read this SketchUp file. The reader does not support every SketchUp version or record. Try saving a copy in a newer SketchUp version. ${cause instanceof Error ? cause.message : ''}`);
  }
  const scene = prepareSketchUp(model, onProgress);
  // The same hash as images added in the app, so a later import or library texture can share the asset.
  for (const image of scene.images) image.sha256 = await hashImageBytes(image.bytes);
  return scene;
}

/** Adapter boundary: tests can exercise malformed reader output without hand-writing SKP bytes. */
export function prepareSketchUp(model: SkpModel, onProgress?: (p: ImportProgress) => void, format: ImportFormat = SKETCHUP_FORMAT,
  options: { /** The caller adds geometry of its own (mesh parts), so a model without faces is not empty. */ allowEmpty?: boolean } = {}): SketchUpImport {
  const warnings = new Set<string>();
  const warn = (message: string): void => { warnings.add(message); };
  for (const note of format.notes) warn(note);
  const materials: SketchUpImport['materials'] = new Map();
  const color = (c: { r: number; g: number; b: number }): Vec3 => [c.r / 255, c.g / 255, c.b / 255];
  const images: ImportedImage[] = [], imageByHash = new Map<string, number>();
  let unusable = 0;
  // TIFF textures become PNG images; each distinct TIFF is converted once.
  const converted = new Map<string, Uint8Array | null>();
  const toPng = (data: Uint8Array): Uint8Array | null => {
    const key = fastHash(data);
    if (!converted.has(key)) {
      try { converted.set(key, tiffToPng(data)); } catch (e) {
        // A malformed TIFF can run past its end; either way the material keeps its color.
        if (!(e instanceof TiffError || e instanceof RangeError)) throw e;
        converted.set(key, null);
      }
    }
    return converted.get(key)!;
  };
  for (const [key, m] of model.materialsById) {
    let texture: ImportedMaterial['texture'] = null;
    const source = m.texture;
    const tiff = source?.data && isTiff(source.data) ? toPng(source.data) : null;
    const data = tiff ?? source?.data, mime = data ? imageMime(data) : null;
    if (source && (!data || !mime || !(source.width > 0) || !(source.height > 0) ||
        !Number.isFinite(source.width) || !Number.isFinite(source.height))) unusable++;
    else if (source && data && mime) {
      // Copy: the reader's bytes can be a view into the whole file.
      const bytes = tiff ?? data.slice(), hash = fastHash(bytes);
      let image = imageByHash.get(hash);
      if (image === undefined) {
        const size = imageSizeFromHeader(bytes);
        const name = source.filename.split(/[\\/]/).pop() || m.name;
        image = images.push({ name: tiff ? name.replace(/\.[^.]*$/, '') + '.png' : name, mime, bytes,
          width: size?.width ?? 0, height: size?.height ?? 0, sha256: hash }) - 1;
        imageByHash.set(hash, image);
      }
      texture = { image, widthM: source.width * INCH, heightM: source.height * INCH,
        // The material color is the colorize color. Older files' material type and colorize type come
        // from PushForm's reader patch.
        ...(m.colorized ? { colorize: m.colorizeType === 1 ? 'tint' as const : 'shift' as const } : {}) };
    }
    // Opacity is the material's own opacity setting (openskp's `transparency`, 1 = opaque). The color's
    // alpha byte of pre-2021 files is not opacity: textured materials store their texture's average there, and many
    // opaque materials store 0.
    materials.set(key, { name: m.name, color: color(m.color), alpha: Math.max(0, Math.min(1, m.transparency)), texture });
  }
  if (unusable) warn(`${unusable} texture image${unusable === 1 ? ' is' : 's are'} missing from the file or not PNG, JPEG, GIF, BMP or a TIFF PushForm can read; ${unusable === 1 ? 'its material uses its' : 'their materials use their'} color.`);
  const definitions = new Map<number, ImportedDefinition>();
  const uv: UvContext = { materials, inherited: inheritedTextures(model, materials) };
  const crossings: CrossingTally = { faces: new Set(), pieces: 0, unshaded: 0 };
  // Only reachable definitions: unused library contents must not multiply import cost or appear as objects.
  const active = new Set<number>(), done = new Set<number>();
  const major = Number(/\d+/.exec(model.version)?.[0] ?? 0);
  const tally: AnnotationTally = { skippedDimensions: 0, skippedGuides: 0, skippedPlanes: 0, rays: 0, unnamedPlanes: 0,
    numberPlanes: major < 18 };
  const counts = { reversed: 0, openParts: 0, openFaces: 0 };
  const visit = (source: Definition, key: number, depth: number): ImportedDefinition => {
    if (depth > 128) throw new Error(`${format.name} component nesting exceeds 128 levels.`);
    const result = convertDefinition(source, key, warn, uv, counts, crossings, format);
    convertAnnotations(source, result, tally);
    active.add(key);
    for (const [index, inst] of source.instances.entries()) {
      const context = `${source.name || 'Model'}: instance ${inst.name || inst.refIdx} (placement ${index + 1})`;
      const child = model.definitions.get(inst.refIdx);
      if (!child) { warn(`${context} skipped: missing component definition.`); continue; }
      if (active.has(inst.refIdx)) { warn(`${context} skipped: cyclic component reference.`); continue; }
      try {
        const transform = sketchUpTransform(inst.matrix);
        if (!done.has(inst.refIdx)) {
          definitions.set(inst.refIdx, visit(child, inst.refIdx, depth + 1));
          done.add(inst.refIdx);
        }
        if (inst.materialId !== null && !materials.has(inst.materialId)) warn(`${context}: missing material; default material used.`);
        result.instances.push({ definition: inst.refIdx, name: inst.name, transform,
          material: inst.materialId, hidden: inst.hidden, tag: inst.layer, properties: { ...inst.properties } });
      } catch (cause) {
        // Transform failures affect this placement only; conversion/resource failures abort the whole import.
        if (cause instanceof Error && /instance transform/.test(cause.message)) warn(`${context} skipped: ${cause.message}.`);
        else throw cause;
      }
    }
    active.delete(key);
    onProgress?.({ stage: 'Converting geometry', current: done.size + 1, total: model.definitions.size + 1 });
    return result;
  };
  // Root is not in the reader's numeric definitions map. Use an impossible source key.
  const root = visit(model.root, -1, 0);
  if (tally.skippedDimensions) warn(`${tally.skippedDimensions} dimension(s) skipped: the reader could not locate their measured points.`);
  if (tally.skippedGuides) warn(`${tally.skippedGuides} guide(s) skipped: invalid position or direction.`);
  if (tally.skippedPlanes) warn(`${tally.skippedPlanes} section plane(s) skipped: invalid plane.`);
  if (tally.rays) warn(`${tally.rays} guide line(s) bounded on one side only are imported as infinite guide lines.`);
  if (counts.openParts) warn(`${counts.openParts} connected part${counts.openParts === 1 ? ' does' : 's do'} not form a closed solid; ${counts.openParts === 1 ? 'its' : 'their'} ${counts.openFaces} face${counts.openFaces === 1 ? ' is' : 's are'} imported as editable sheet faces.`);
  if (counts.reversed) warn(`${counts.reversed} inside-out solid(s) reversed: closed shells whose faces all faced inward are imported as solids facing outward.`);
  if (crossings.faces.size) warn(`${crossings.faces.size} face${crossings.faces.size === 1 ? ' whose outline crosses or touches itself is' : 's whose outlines cross or touch themselves are'} imported as ${crossings.pieces} simple sheet face${crossings.pieces === 1 ? '' : 's'} covering the region SketchUp shades, cut where ${crossings.faces.size === 1 ? 'its outline crosses' : 'their outlines cross'}.`);
  if (crossings.unshaded) warn(`${crossings.unshaded} outline segment${crossings.unshaded === 1 ? '' : 's'} of these faces bound${crossings.unshaded === 1 ? 's' : ''} no shaded area and no other face, and ${crossings.unshaded === 1 ? 'is' : 'are'} not imported: SketchUp keeps ${crossings.unshaded === 1 ? 'it as an edge' : 'them as edges'} of the face, not as loose edges.`);
  for (const def of [root, ...definitions.values()]) for (const face of [...def.sheets, ...def.solids.flatMap(b => b.faces)]) {
    if ((face.front !== null && !materials.has(face.front)) || (face.back !== null && !materials.has(face.back)))
      warn('Some faces reference unavailable materials; default material is used on those sides.');
  }
  // Section planes, guides and dimensions are model content too: a file of guide lines alone opens.
  if (!options.allowEmpty && ![root, ...definitions.values()].some(d => d.solids.length || d.sheets.length || d.edges.length ||
    d.sectionPlanes.length || d.guides.length || d.dimensions.length))
    throw new Error(`No supported geometry was found in this ${format.name} file. It may be empty or contain records the reader cannot recover.`);
  const point = (p: [number, number, number]): Vec3 => [p[0] * INCH, p[1] * INCH, p[2] * INCH];
  // SketchUp's scene flags: 1 saves the camera, 32 saves tag visibility. Files without flags save both.
  const saves = (flags: number | null, bit: number): boolean => flags === null || (flags & bit) !== 0;
  const scenes: ImportedScene[] = model.pages.map(page => {
    const valid = page.eye && page.target && page.up && [...page.eye, ...page.target, ...page.up].every(Number.isFinite) &&
      v3len(v3sub(point(page.target), point(page.eye))) > LENGTH_TOL && v3len(page.up) > LENGTH_TOL;
    if (!valid && saves(page.flags, 1)) warn(`Scene "${page.name}" has no usable camera; it keeps only its tag visibility.`);
    // Bit 2 of the flags: the scene saves its style.
    const display = saves(page.flags, 2) ? sketchUpDisplay(page.renderingOptions) : null;
    return { name: page.name, hiddenTags: [...page.hiddenLayers], usesTags: saves(page.flags, 32), camera: valid ? {
      eye: point(page.eye!), target: point(page.target!), up: v3normalize(page.up!), perspective: !page.parallel,
      fov: Number.isFinite(page.fov) && page.fov > 0 ? page.fov : 35, height: page.orthoHeight * INCH,
    } : null, display };
  });
  if (model.scenesUnread > 0) warn(`${model.scenesUnread} saved scene(s) could not be read and are not imported.`);
  return { version: model.version, root, definitions, materials, images,
    tags: (model.layers as ReaderLayer[]).map(l => ({ name: l.name, color: color(l.color), visible: !l.hidden, ...(l.folder != null ? { folder: l.folder } : {}) })),
    tagFolders: ((model as ReaderModel).tagFolders ?? []).map(f => ({ name: f.name, visible: !f.hidden, parent: f.parent })), scenes,
    units: sketchUpUnits(model.unitsOptions), sectionDisplay: model.sectionDisplay ?? null,
    display: sketchUpDisplay(model.renderingOptions), warnings: [...warnings], format };
}

// SketchUp's Length constants, indexed by their stored codes.
const LENGTH_UNITS: readonly LengthUnit[] = ['in', 'ft', 'mm', 'cm', 'm', 'yd'];
const LENGTH_FORMATS: readonly LengthFormat[] = ['decimal', 'architectural', 'engineering', 'fractional'];
const AREA_UNITS: readonly UnitSettings['areaUnit'][] = ['in²', 'ft²', 'mm²', 'cm²', 'm²', 'yd²'];
const VOLUME_UNITS: readonly UnitSettings['volumeUnit'][] = ['in³', 'ft³', 'mm³', 'cm³', 'm³', 'yd³', 'l'];
const MAX_PRECISION = 6;
/** SketchUp's snap length, in inches, when the stored one is not positive. */
const DEFAULT_SNAP_INCHES = 1 / 16;

/**
 * The display units of a SketchUp model's "UnitsOptions". SketchUp's LengthPrecision counts decimal places
 * for decimal and engineering lengths and is the power of two of the smallest fraction (1/2^n inch) for
 * architectural and fractional ones, as PushForm's lengthPrecision does, so it carries over unchanged.
 * Null without a recognizable length unit and format. Files from before SketchUp had area and volume units
 * get the units matching the length unit; other missing or unknown values keep
 * PushForm's defaults.
 */
export function sketchUpUnits(options: Readonly<Record<string, number | boolean>> | null): UnitSettings | null {
  if (!options) return null;
  const code = (key: string): number | null => {
    const value = options[key];
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
  };
  const pick = <T>(table: readonly T[], key: string): T | undefined => table[code(key) ?? -1];
  const precision = (key: string, fallback: number): number => {
    const value = code(key);
    return value === null ? fallback : Math.min(MAX_PRECISION, Math.max(0, value));
  };
  const flag = (key: string): boolean | null => {
    const value = options[key];
    return typeof value === 'boolean' ? value : null;
  };
  const positive = (key: string): number | null => {
    const value = options[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  };
  const lengthUnit = pick(LENGTH_UNITS, 'LengthUnit'), format = pick(LENGTH_FORMATS, 'LengthFormat');
  if (!lengthUnit || !format) return null;
  // Area and volume codes follow the length codes up to yards; volume adds liters and US gallons after them.
  const lengthCode = LENGTH_UNITS.indexOf(lengthUnit);
  const unitOf = <T>(table: readonly T[], key: string): T | undefined => key in options ? pick(table, key) : table[lengthCode];
  return {
    format, lengthUnit,
    lengthPrecision: precision('LengthPrecision', DEFAULT_UNITS.lengthPrecision),
    areaUnit: unitOf(AREA_UNITS, 'AreaUnit') ?? DEFAULT_UNITS.areaUnit,
    areaPrecision: precision('AreaPrecision', DEFAULT_UNITS.areaPrecision),
    volumeUnit: unitOf(VOLUME_UNITS, 'VolumeUnit') ?? DEFAULT_UNITS.volumeUnit,
    volumePrecision: precision('VolumePrecision', DEFAULT_UNITS.volumePrecision),
    // Snap lengths are stored in inches, snap angles in degrees.
    lengthSnap: flag('LengthSnapEnabled') === true ? (positive('LengthSnapLength') ?? DEFAULT_SNAP_INCHES) * INCH : null,
    angleSnap: flag('AngleSnapEnabled') === false ? null : positive('SnapAngle') ?? DEFAULT_UNITS.angleSnap,
    anglePrecision: precision('AnglePrecision', DEFAULT_UNITS.anglePrecision),
    displayUnitSuffix: flag('SuppressUnitsDisplay') !== true,
    forceZeroInches: flag('ForceInchDisplay') === true,
  };
}

interface UvContext {
  materials: SketchUpImport['materials'];
  /** Keys of the definitions whose unpainted faces inherit a texture from some placement. */
  inherited: Set<number>;
}

/**
 * The definitions whose unpainted faces inherit a texture: a placement's own material, else the material its parent
 * placement passes down. Each (definition, inherited material) pair is visited once.
 */
function inheritedTextures(model: SkpModel, materials: SketchUpImport['materials']): Set<number> {
  const out = new Set<number>(), seen = new Set<string>();
  const stack: [Definition, number | null][] = [[model.root, null]];
  while (stack.length) {
    const [def, material] = stack.pop()!;
    for (const inst of def.instances) {
      const child = model.definitions.get(inst.refIdx), effective = inst.materialId ?? material;
      if (!child || seen.has(`${inst.refIdx}:${effective}`)) continue;
      seen.add(`${inst.refIdx}:${effective}`);
      if (effective !== null && materials.get(effective)?.texture) out.add(inst.refIdx);
      stack.push([child, effective]);
    }
  }
  return out;
}

type ProjectedFace = Face & { uvProjection?: number[] | null; uvProjectionBack?: number[] | null; layer?: string };
/** meshTopologyProblems' finding for a closed, consistently oriented shell that faces inward. */
const INSIDE_OUT = 'signed volume is not positive';

/** The same triangles wound the other way. */
function reverseTriangles(tris: Uint32Array): Uint32Array {
  const out = tris.slice();
  for (let i = 0; i + 2 < out.length; i += 3) { out[i + 1] = tris[i + 2]!; out[i + 2] = tris[i + 1]!; }
  return out;
}

/**
 * Turns a face over: its loops run the other way from the same first point, so each loop's edge flags
 * (segment i runs from point i to point i + 1) reverse with it; the normal flips and the sides swap.
 * Texture placements are set afterwards from the final orientation.
 */
function reverseFace(face: ImportedFace): void {
  face.loops = face.loops.map(loop => [loop[0]!, ...loop.slice(1).reverse()]);
  face.edgeFlags = face.edgeFlags.map(flags => [...flags].reverse());
  face.normal = v3scale(face.normal, -1);
  [face.front, face.back] = [face.back, face.front];
}

/** Faces whose outline crosses or touches itself (by definition and source face), and the simple sheet faces they are imported as. */
interface CrossingTally {
  faces: Set<string>; pieces: number;
  /** Outline segments that bound no shaded piece and no other face, so are not imported. */
  unshaded: number;
}

/**
 * The picture of an image in a .skp file, when its definition has the form the format uses for one: a single face, the
 * rectangle from its four vertices lying in the xy plane with sides along x and y, painted on either side with a
 * textured material.
 */
function pictureOf(source: Definition, uv: UvContext): ImportedDefinition['picture'] {
  if (source.faces.length !== 1 || source.vertices.length !== 4) return undefined;
  const face = source.faces[0]!;
  const material = [face.materialId, face.backMaterialId].find(m => m !== null && uv.materials.get(m)?.texture);
  if (material === undefined || material === null) return undefined;
  const xs = source.vertices.map(v => v.x), ys = source.vertices.map(v => v.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const flat = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
  const corners = source.vertices.every(v => flat(v.z, 0) && (flat(v.x, x0) || flat(v.x, x1)) && (flat(v.y, y0) || flat(v.y, y1)));
  const distinct = new Set(source.vertices.map(v => `${flat(v.x, x0) ? 0 : 1}${flat(v.y, y0) ? 0 : 1}`)).size === 4;
  if (!corners || !distinct || x1 - x0 <= 0 || y1 - y0 <= 0) return undefined;
  return { material, origin: [x0 * INCH, y0 * INCH, 0], widthM: (x1 - x0) * INCH, heightM: (y1 - y0) * INCH };
}

function convertDefinition(source: Definition, key: number, warn: (m: string) => void, uv: UvContext,
  counts: { reversed: number; openParts: number; openFaces: number }, crossings: CrossingTally, format: ImportFormat): ImportedDefinition {
  const result: ImportedDefinition = { key, guid: source.guid, name: source.name, image: source.isImage,
    group: (source as ReaderDefinition).isGroup ?? false,
    alwaysFaceCamera: source.alwaysFacesCamera, shadowsFaceSun: source.shadowsFaceSun,
    solids: [], sheets: [], edges: [], curves: [], sectionPlanes: [], guides: [], dimensions: [], texts: convertTexts(source, warn, uv.materials), instances: [] };
  if (source.isImage) {
    const picture = pictureOf(source, uv);
    if (picture) result.picture = picture;
    else {
      const textured = source.faces.some(f => f.materialId !== null && uv.materials.get(f.materialId)?.texture);
      warn(textured ? `${source.name || 'Image'}: a SketchUp image that is not a single flat rectangle is imported as a component holding its textured geometry.`
        : `${source.name || 'Image'}: image entity imported as untextured component geometry.`);
    }
  }
  if (source.faces.length > 500_000 || source.vertices.length > 2_000_000)
    throw new Error(`A ${format.name} definition exceeds the initial geometry limit (500,000 faces or 2,000,000 vertices).`);
  const vertices = new Map(source.vertices.map(v => [v.id, [v.x * INCH, v.y * INCH, v.z * INCH] as Vec3]));
  const edges = new Map(source.edges.map(e => [e.id, e]));
  const referenced = new Set<number>();
  const faces: ImportedFace[] = [];
  const triangles: Triangulated[] = [];
  // Each kept face's source record, with SketchUp's normal and its boundary points (the whole source face's
  // for a crossing face's pieces, which share the placement fitted to it).
  type Side = { face: ProjectedFace; normal: Vec3; points: Vec3[] };
  const sides: Side[] = [], crossingSides: Side[] = [];
  const skip = (face: Face, cause: unknown): void =>
    warn(`${source.name || 'Model'}: face ${face.id} skipped: ${cause instanceof Error ? cause.message : String(cause)}.`);
  // First every face's outline; a face whose outline crosses or touches itself is cut into the simple
  // faces SketchUp shades, and the points where it is cut are later added to the sheets along those edges.
  const outlines: { face: Face; normal: Vec3; points: Vec3[]; piece: FacePiece; tri: Triangulated | null; crossing: boolean }[] = [];
  const splits = new Map<number, Vec3[]>(), unshaded: ShadedRegion['unshaded'] = [];
  for (const face of source.faces) {
    for (const loop of face.loops) for (const ref of loop) referenced.add(ref.edgeId);
    try {
      const loops = faceLoops(face, edges, vertices);
      if (!face.normal.every(Number.isFinite) || v3len(face.normal) < LENGTH_TOL) throw new Error('invalid normal');
      const normal = v3normalize(face.normal);
      // SketchUp keeps a face's points within tolerance of its own plane, which passes near their centroid,
      // so a plane through one corner can see twice the deviation.
      const points = loops.flat(), mean = (axis: 0 | 1 | 2): number => points.reduce((sum, p) => sum + p[axis], 0) / points.length;
      const centroid: Vec3 = [mean(0), mean(1), mean(2)];
      if (points.some(p => Math.abs(v3dot(v3sub(p, centroid), normal)) > MERGE_TOL))
        throw new Error('nonplanar boundary');
      const piece = { loops, edges: face.loops.map(loop => loop.map(ref => ref.edgeId)) };
      const tri = triangulateOutline(loops, normal);
      if (tri.covers) { outlines.push({ face, normal, points, piece, tri, crossing: false }); continue; }
      const region = shadedRegion(loops, piece.edges, normal);
      if (!region) throw new Error(tri.indices.length ? 'degenerate triangulation' : 'empty triangulation');
      for (const part of region.pieces) outlines.push({ face, normal, points, piece: part, tri: null, crossing: true });
      for (const [edge, list] of region.splits) {
        const all = splits.get(edge) ?? splits.set(edge, []).get(edge)!;
        for (const p of list) if (!all.some(q => v3dist(q, p) <= LENGTH_TOL)) all.push(p);
      }
      unshaded.push(...region.unshaded);
    } catch (cause) { skip(face, cause); }
  }
  // A cut point also cuts every other face edge that runs through it (overlapping or collinear source edges).
  if (splits.size) addThroughSplits(splits, source.edges.filter(e => referenced.has(e.id)), vertices);
  const crossingSheets: ImportedFace[] = [];
  for (const outline of outlines) {
    const { face, normal, points } = outline, projected = face as ProjectedFace;
    try {
      const piece = outline.piece, tri = outline.tri ?? triangulateOutline(piece.loops, normal);
      if (!tri.indices.length) throw new Error('empty triangulation');
      if (!tri.covers) throw new Error('degenerate triangulation');
      // Texture placement waits until the face's orientation is settled (below).
      const imported: ImportedFace = { id: faces.length + crossingSheets.length, sourceId: face.id, loops: piece.loops, normal,
        front: face.materialId, back: face.backMaterialId, frontUv: null, backUv: null, hidden: face.hidden,
        edgeFlags: piece.edges.map(ring => ring.map(id => edgeFlags(edges.get(id)!))),
        ...(projected.layer ? { tag: projected.layer } : {}) };
      const side: Side = { face: projected, normal, points };
      // Pieces of a crossing face are sheets only: they never join a solid.
      if (outline.crossing) {
        crossingSheets.push(imported); crossingSides.push(side);
        crossings.faces.add(`${key}:${face.id}`); crossings.pieces++;
      } else { faces.push(imported); sides.push(side); triangles.push(tri); }
    } catch (cause) { skip(face, cause); }
  }
  // Solid faces are numbered by their index; crossing pieces follow them.
  crossingSheets.forEach((face, i) => { face.id = faces.length + i; });
  // Weld triangle positions before topology validation. Keep per-source-face ids and materials.
  const positions: number[] = [], indices: number[] = [], faceIds: number[] = [];
  triangles.forEach((tri, i) => {
    const offset = positions.length / 3;
    for (const p of tri.positions) positions.push(p);
    for (const index of tri.indices) indices.push(index + offset);
    for (let j = 0; j < tri.indices.length / 3; j++) faceIds.push(i);
  });
  const verts = Float64Array.from(positions), canonical = weldVertices(verts, MERGE_TOL);
  const parents = faces.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parents[r] !== r) r = parents[r]!;
    while (parents[i] !== i) { const next = parents[i]!; parents[i] = r; i = next; }
    return r;
  };
  // A triangle two of whose corners weld together encloses no area: it takes no part in a solid.
  const collapsed = (i: number): boolean => {
    const a = canonical[indices[i]!]!, b = canonical[indices[i + 1]!]!, c = canonical[indices[i + 2]!]!;
    return a === b || b === c || a === c;
  };
  const adjacent = new Map<string, number>();
  for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3 && !collapsed(i); j++) {
    const a = canonical[indices[i + j]!]!, b = canonical[indices[i + (j + 1) % 3]!]!;
    const edgeKey = a < b ? `${a}:${b}` : `${b}:${a}`, face = faceIds[i / 3]!;
    const other = adjacent.get(edgeKey);
    if (other === undefined) adjacent.set(edgeKey, face);
    else parents[find(face)] = find(other);
  }
  const groups = new Map<number, number[]>();
  faces.forEach((_, i) => { const k = find(i); (groups.get(k) ?? groups.set(k, []).get(k)!).push(i); });
  const trisByGroup = new Map<number, { indices: number[]; faces: number[] }>();
  for (let i = 0; i < indices.length; i += 3) {
    if (collapsed(i)) continue;
    const face = faceIds[i / 3]!, k = find(face);
    const group = trisByGroup.get(k) ?? trisByGroup.set(k, { indices: [], faces: [] }).get(k)!;
    group.indices.push(canonical[indices[i]!]!, canonical[indices[i + 1]!]!, canonical[indices[i + 2]!]!);
    group.faces.push(face);
  }
  for (const edge of source.edges) {
    const a = vertices.get(edge.v1Id), b = vertices.get(edge.v2Id);
    if (!a || !b || ![...a, ...b].every(Number.isFinite) || v3len(v3sub(a, b)) <= LENGTH_TOL) {
      warn(`${source.name || 'Model'}: edge ${edge.id} skipped: invalid endpoints.`); continue;
    }
    if (!referenced.has(edge.id)) result.edges.push({ a, b, ...edgeFlags(edge) });
  }
  for (const [group, ids] of groups) {
    const componentFaces = ids.map(i => faces[i]!);
    const { indices: sourceIndices, faces: triangleFaces } = trisByGroup.get(group) ?? { indices: [], faces: [] };
    const remap = new Map<number, number>(), compact: number[] = [];
    const tris = Uint32Array.from(sourceIndices, index => {
      let mapped = remap.get(index);
      if (mapped === undefined) { mapped = remap.size; remap.set(index, mapped); compact.push(verts[index * 3]!, verts[index * 3 + 1]!, verts[index * 3 + 2]!); }
      return mapped;
    });
    let mesh: MeshData = { verts: Float64Array.from(compact), tris, faceId: Uint32Array.from(triangleFaces) };
    // Faces narrower than the merge tolerance have no triangle left; SketchUp keeps them, so they stay sheets.
    let problems = tris.length ? meshTopologyProblems(mesh) : ['its triangles weld away at the merge tolerance'];
    // A closed, consistently oriented shell that is only inside out is a solid in SketchUp: turn it outward.
    if (problems.length === 1 && problems[0] === INSIDE_OUT) {
      const reversed: MeshData = { ...mesh, tris: reverseTriangles(mesh.tris) };
      if (!meshTopologyProblems(reversed).length) {
        mesh = reversed; problems = [];
        componentFaces.forEach(reverseFace);
        counts.reversed++;
      }
    }
    if (problems.length) {
      for (const face of componentFaces) result.sheets.push(face);
      // Mesh formats are mostly open surfaces, so their open parts are counted together rather than listed one by one;
      // SketchUp, COLLADA and STEP parts are named and expected to be solid.
      if (format.kind === 'sketchup' || format.kind === 'collada' || format.kind === 'step')
        warn(`${source.name || 'Model'}: component at source face ${componentFaces[0]!.sourceId}, ${componentFaces.length} face(s) retained as editable sheets: ${problems[0]}.`);
      else { counts.openParts++; counts.openFaces += componentFaces.length; }
    } else {
      result.solids.push({ mesh, faces: componentFaces });
    }
  }
  // A side's own textured material carries its placement. A side without one shows the texture its
  // placements inherit by default, whatever its size; it is kept where PushForm's
  // automatic mapping turns from it, on faces facing up or down. Both sides are placed in the frame
  // of the side's own normal. A reversed face's sides swap, and their placements are compared with the automatic
  // mapping of the reversed normal.
  const placement = (material: number | null, transform: number[] | null | undefined, projection: number[] | null | undefined,
    side: { normal: Vec3; points: Vec3[] }, normal: Vec3): ImportedUvMap | null => {
    if (material === null) return uv.inherited.has(key) ? defaultUvMap(side.normal, normal) : null;
    const texture = uv.materials.get(material)?.texture;
    return texture ? sideUvMap(side.normal, transform ?? null, projection ?? null, texture, side.points, normal) : null;
  };
  const place = (face: ImportedFace, side: Side): void => {
    const f = side.face;
    const front = placement(f.materialId, f.uvTransform, f.uvProjection, side, face.normal);
    const back = placement(f.backMaterialId, f.uvTransformBack, f.uvProjectionBack, side, face.normal);
    [face.frontUv, face.backUv] = v3dot(face.normal, side.normal) > 0 ? [front, back] : [back, front];
  };
  faces.forEach((face, i) => place(face, sides[i]!));
  crossingSheets.forEach((face, i) => place(face, crossingSides[i]!));
  result.sheets.push(...crossingSheets);
  // Sheets along an edge a crossing face cuts share the cut's vertex, so the sketch has no overlapping edges.
  // Solid faces keep their edges whole: a solid's edges are separate from the sketch's.
  if (splits.size) for (const face of result.sheets) {
    const flags = face.edgeFlags.map(ring => new Map(ring.map(f => [f.edge, f])));
    const cut = insertSplits(face.loops, face.edgeFlags.map(ring => ring.map(f => f.edge)), splits);
    face.loops = cut.loops;
    face.edgeFlags = cut.edges.map((ring, k) => ring.map(id => ({ ...flags[k]!.get(id)! })));
  }
  // The parts of a crossing outline around no shaded piece (a backwards lobe, an outline doubling back
  // over itself, holes overlapping one another) are edges of that face in SketchUp, never loose edges.
  // A sketch edge bounding no face is loose, so they are not imported; another face along them still
  // has its own edges there. Source edges with no part left are left out of their curves.
  const omitted = new Set<number>();
  if (unshaded.length) {
    const pair = (a: Vec3, b: Vec3): string => { const p = a.join(','), q = b.join(','); return p < q ? `${p} ${q}` : `${q} ${p}`; };
    const drawn = new Set<string>(), kept = new Set<number>();
    for (const face of [...faces, ...crossingSheets]) {
      for (const ring of face.edgeFlags) for (const f of ring) kept.add(f.edge);
      const cut = insertSplits(face.loops, face.edgeFlags.map(ring => ring.map(f => f.edge)), splits);
      for (const ring of cut.loops) ring.forEach((a, i) => drawn.add(pair(a, ring[(i + 1) % ring.length]!)));
    }
    for (const part of unshaded) {
      if (!kept.has(part.edge)) omitted.add(part.edge);
      const points = splitSegment(part.a, part.b, splits.get(part.edge) ?? []);
      for (let i = 0; i + 1 < points.length; i++) {
        const key = pair(points[i]!, points[i + 1]!);
        if (!drawn.has(key)) { drawn.add(key); crossings.unshaded++; }
      }
    }
  }
  keepCurves(source as ReaderDefinition, vertices, result, warn, splits, omitted);
  return result;
}

interface Triangulated { positions: Float64Array; indices: Uint32Array; covers: boolean }

/**
 * Triangulates a face's loops in its plane, and whether the triangles cover the area the loops enclose.
 * A triangulation that does not cover the boundary's area (a self-crossing outline, for example) does not
 * make a face. Both areas are measured in the face plane, so a twist within the planarity tolerance does not
 * count. The triangles meet every outline segment edge for edge (`withoutSlivers`), as a solid's mesh needs.
 */
function triangulateOutline(loops: Vec3[][], normal: Vec3): Triangulated {
  const tri = triangulatePlanarFace(loops, planeBasis(loops[0]![0]!, normal));
  const indices = withoutSlivers(tri.positions, tri.indices, tri.ringStarts);
  let covered = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const point = (j: number): Vec3 => [tri.positions[j * 3]!, tri.positions[j * 3 + 1]!, tri.positions[j * 3 + 2]!];
    const a = point(indices[i]!), b = point(indices[i + 1]!), c = point(indices[i + 2]!);
    covered += Math.abs(v3dot(v3cross(v3sub(b, a), v3sub(c, a)), normal)) / 2;
  }
  const area = loopArea(loops[0]!, normal) - loops.slice(1).reduce((sum, loop) => sum + loopArea(loop, normal), 0);
  return { positions: tri.positions, indices, covers: indices.length > 0 && area > AREA_TOL &&
    Math.abs(covered - area) <= Math.max(AREA_TOL, area * TRIANGULATION_AREA_TOL) };
}

/**
 * Where collinear outline points meet (two window holes whose sills lie on one line, say), the triangulation
 * can leave zero-area slivers and run a triangle edge straight past a vertex. The face next door meets that
 * vertex, so the shared edge has no twin and a closed shell the file marks as a solid would stay sheets
 *. This drops the slivers and splits each edge that runs past one of the face's vertices; the
 * triangles then cover the same area and meet every outline segment exactly.
 */
function withoutSlivers(positions: Float64Array, indices: Uint32Array, ringStarts: readonly number[]): Uint32Array {
  const point = (j: number): Vec3 => [positions[j * 3]!, positions[j * 3 + 1]!, positions[j * 3 + 2]!];
  const doubleArea = (a: number, b: number, c: number): number => v3len(v3cross(v3sub(point(b), point(a)), v3sub(point(c), point(a))));
  const key = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const kept: [number, number, number][] = [], directed = new Set<string>();
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!;
    if (doubleArea(a, b, c) <= 2 * AREA_TOL) continue;
    kept.push([a, b, c]);
    directed.add(`${a}>${b}`); directed.add(`${b}>${c}`); directed.add(`${c}>${a}`);
  }
  // A sound triangulation has every edge either on the outline or shared by two triangles; only the others need work.
  const count = positions.length / 3, outline = new Set<string>();
  ringStarts.forEach((start, r) => {
    const end = ringStarts[r + 1] ?? count;
    for (let i = start; i < end; i++) outline.add(key(i, i + 1 < end ? i + 1 : start));
  });
  const suspect = new Set<string>();
  for (const [a, b, c] of kept) for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
    if (!outline.has(key(x, y)) && !directed.has(`${y}>${x}`)) suspect.add(key(x, y));
  }
  if (!suspect.size && kept.length * 3 === indices.length) return indices;
  // The vertices sorted along the axis the face spreads most in, so an edge only looks at the vertices within its extent.
  const spread = [0, 1, 2].map(k => {
    let lo = Infinity, hi = -Infinity;
    for (let j = k; j < positions.length; j += 3) { lo = Math.min(lo, positions[j]!); hi = Math.max(hi, positions[j]!); }
    return hi - lo;
  });
  const axis = spread.indexOf(Math.max(...spread));
  const sorted = Array.from({ length: count }, (_, i) => i).sort((u, v) => positions[u * 3 + axis]! - positions[v * 3 + axis]!);
  const firstFrom = (value: number): number => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (positions[sorted[mid]! * 3 + axis]! < value) lo = mid + 1; else hi = mid; }
    return lo;
  };
  // A vertex strictly inside a suspect segment from `a` to `b`, if any.
  const between = (a: number, b: number): number | undefined => {
    if (!suspect.has(key(a, b))) return undefined;
    const pa = point(a), d = v3sub(point(b), pa), length2 = v3dot(d, d), length = Math.sqrt(length2);
    const from = Math.min(pa[axis]!, pa[axis]! + d[axis]!) - LENGTH_TOL, to = Math.max(pa[axis]!, pa[axis]! + d[axis]!) + LENGTH_TOL;
    for (let i = firstFrom(from); i < sorted.length && positions[sorted[i]! * 3 + axis]! <= to; i++) {
      const v = sorted[i]!;
      if (v === a || v === b) continue;
      const w = v3sub(point(v), pa), t = v3dot(w, d) / length2;
      if (t * length <= LENGTH_TOL || (1 - t) * length <= LENGTH_TOL) continue;
      if (v3len(v3sub(w, v3scale(d, t))) <= LENGTH_TOL) return v;
    }
    return undefined;
  };
  const out: number[] = [];
  while (kept.length) {
    const [a, b, c] = kept.pop()!;
    let split: { x: number; y: number; z: number; v: number } | null = null;
    for (const [x, y, z] of [[a, b, c], [b, c, a], [c, a, b]] as const) {
      const v = between(x, y);
      if (v !== undefined) { split = { x, y, z, v }; break; }
    }
    if (!split) { out.push(a, b, c); continue; }
    const { x, y, z, v } = split;
    // Both halves of a split edge stay suspect: further vertices may lie on them.
    suspect.add(key(x, v)); suspect.add(key(v, y));
    kept.push([x, v, z], [v, y, z]);
  }
  return Uint32Array.from(out);
}

function edgeFlags(edge: ReaderEdge): ImportedEdgeFlags {
  return { soft: edge.soft, smooth: edge.smooth, hidden: edge.hidden, edge: edge.id, curve: edge.curve ?? null, ...(edge.layer ? { tag: edge.layer } : {}) };
}

/**
 * Keeps each SketchUp curve whose edges form one chain and all landed in one place (a single solid, or the
 * sketch with its sheets and loose edges); a PushForm curve record cannot span both. Other curves' edges
 * stay as plain edges. A curve with an edge cut where a face's outline crosses it is freehand: its vertices
 * no longer match its arc's segments.
 */
function keepCurves(source: ReaderDefinition, vertices: Map<number, Vec3>, result: ImportedDefinition, warn: (m: string) => void,
  splits: ReadonlyMap<number, readonly Vec3[]>, omitted: ReadonlySet<number>): void {
  const records = source.curves ?? [];
  if (!records.length) return;
  const home = new Map<number, number | 'sketch' | null>();
  const place = (edge: number, where: number | 'sketch'): void => {
    const previous = home.get(edge);
    home.set(edge, previous === undefined || previous === where ? where : null);
  };
  result.solids.forEach((solid, k) => { for (const face of solid.faces) for (const loop of face.edgeFlags) for (const f of loop) place(f.edge, k); });
  for (const face of result.sheets) for (const loop of face.edgeFlags) for (const f of loop) place(f.edge, 'sketch');
  for (const edge of result.edges) place(edge.edge, 'sketch');
  // A curve keeps the edges that were imported: an edge left out because it bounds no shaded part of a
  // crossing face (above) is not part of it, and a curve that loses one is freehand.
  const members = new Map<number, ReaderEdge[]>(), partial = new Set<number>();
  for (const edge of source.edges as ReaderEdge[]) {
    if (edge.curve === null || edge.curve === undefined) continue;
    if (omitted.has(edge.id)) { partial.add(edge.curve); continue; }
    (members.get(edge.curve) ?? members.set(edge.curve, []).get(edge.curve)!).push(edge);
  }
  let dropped = 0;
  for (const record of records) {
    const edges = members.get(record.id);
    if (!edges) continue;
    const where = new Set(edges.map(e => home.get(e.id) ?? null));
    const chain = edgeChain(edges), target = [...where][0];
    if (where.size !== 1 || target === null || target === undefined || !chain) { dropped++; continue; }
    const points = chain.vertices.map(id => vertices.get(id)!);
    // Solid faces keep their edges whole, so only a curve in the sketch is cut.
    const cuts = target === 'sketch' ? edges.reduce((sum, e) => sum + (splits.get(e.id)?.length ?? 0), 0) : 0;
    const curve = fitCurve(cuts || partial.has(record.id) ? { ...record, arc: null } : record, points, chain);
    result.curves.push({ source: record.id, ...curve, segments: curve.segments + cuts, home: target });
  }
  const kept = new Set(result.curves.map(c => c.source));
  const clear = (f: ImportedEdgeFlags): void => { if (f.curve !== null && !kept.has(f.curve)) f.curve = null; };
  for (const face of [...result.sheets, ...result.solids.flatMap(s => s.faces)]) for (const loop of face.edgeFlags) loop.forEach(clear);
  result.edges.forEach(clear);
  if (dropped) warn(`${source.name || 'Model'}: ${dropped} curve(s) imported as separate edges: their edges do not form one chain, or are split between a solid and other geometry.`);
}

/** Orders a curve's edges end to end. Null unless they form one open or closed chain. */
function edgeChain(edges: ReaderEdge[]): { edges: number[]; vertices: number[]; closed: boolean } | null {
  if (!edges.length) return null;
  const byVertex = new Map<number, ReaderEdge[]>();
  for (const e of edges) for (const v of [e.v1Id, e.v2Id]) (byVertex.get(v) ?? byVertex.set(v, []).get(v)!).push(e);
  if ([...byVertex.values()].some(list => list.length > 2)) return null;
  const ends = [...byVertex].filter(([, list]) => list.length === 1).map(([v]) => v);
  if (ends.length !== 0 && ends.length !== 2) return null;
  const closed = ends.length === 0;
  let v = closed ? edges[0]!.v1Id : ends[0]!;
  const used = new Set<number>(), order: number[] = [], vertices = [v];
  for (;;) {
    const next = byVertex.get(v)!.find(e => !used.has(e.id));
    if (!next) break;
    used.add(next.id); order.push(next.id);
    v = next.v1Id === v ? next.v2Id : next.v1Id;
    vertices.push(v);
  }
  if (order.length !== edges.length) return null;
  if (closed) vertices.pop();
  return { edges: order, vertices, closed };
}

/**
 * PushForm curve geometry for a SketchUp curve. Only the arc's centre, normal and radius are taken from the
 * file: the start angle and sweep come from the vertices, since SketchUp's stored x axis can disagree with
 * them. The result is accepted only when its tessellation reproduces every vertex; otherwise the curve is
 * freehand, which keeps its edges together without claiming arc geometry.
 */
function fitCurve(record: ReaderCurve, points: Vec3[], chain: { edges: number[]; closed: boolean }): Omit<ImportedCurve, 'source' | 'home'> {
  const segments = chain.edges.length, arc = record.arc;
  const finite = (v: readonly number[]): boolean => v.length === 3 && v.every(Number.isFinite);
  if (arc && finite(arc.center) && finite(arc.normal) && finite(arc.xaxis) && finite(arc.yaxis) && v3len(arc.normal) > LENGTH_TOL) {
    const center: Vec3 = [arc.center[0]! * INCH, arc.center[1]! * INCH, arc.center[2]! * INCH];
    const normal = v3normalize(arc.normal), radius = v3len(arc.xaxis) * INCH;
    const basis = planeBasis(center, normal);
    const angle = (p: Vec3): number => { const l = basisToLocal(basis, p); return Math.atan2(l[1], l[0]); };
    const turn = (list: Vec3[]): number => {
      let sum = 0;
      for (let i = 0; i < (chain.closed ? list.length : list.length - 1); i++) {
        let d = angle(list[(i + 1) % list.length]!) - angle(list[i]!);
        if (d > Math.PI) d -= 2 * Math.PI; else if (d <= -Math.PI) d += 2 * Math.PI;
        sum += d;
      }
      return sum;
    };
    // PushForm arcs run counterclockwise about their normal; walk the chain that way.
    let ordered = points, edges = chain.edges, sweep = turn(points);
    if (sweep < 0) {
      ordered = chain.closed ? [points[0]!, ...points.slice(1).reverse()] : [...points].reverse();
      edges = [...chain.edges].reverse();
      sweep = -sweep;
    }
    const kind: CurveKind = chain.closed ? (record.polygon ? 'polygon' : 'circle') : 'arc';
    const startAngle = angle(ordered[0]!), endAngle = startAngle + (chain.closed ? 2 * Math.PI : sweep);
    const curve = { kind, center, normal, radius, startAngle, endAngle, segments };
    const elliptical = Math.abs(v3len(arc.yaxis) * INCH - radius) > MERGE_TOL;
    if (!elliptical) {
      const expected = tessellateCurve(curve);
      if (expected.length === ordered.length && expected.every((p, i) => v3dist(p, ordered[i]!) <= MERGE_TOL))
        return { ...curve, edges };
    }
  }
  // Freehand: centred on its points, in the arc's plane when there is one, else the points' best-fit plane.
  const centroid: Vec3 = [0, 1, 2].map(axis => points.reduce((sum, p) => sum + p[axis as 0 | 1 | 2], 0) / points.length) as unknown as Vec3;
  let normal: Vec3 = arc && finite(arc.normal) && v3len(arc.normal) > LENGTH_TOL ? v3normalize(arc.normal) : [0, 0, 0];
  if (v3len(normal) === 0) {
    const n: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!;
      n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    normal = v3len(n) > AREA_TOL ? v3normalize(n) : [0, 0, 1];
  }
  return { kind: 'freehand', center: centroid, normal, radius: 0, startAngle: 0, endAngle: 0, segments, edges: chain.edges };
}

/** Annotation tallies across one import. Unnamed section planes from files older than SketchUp 2018 are numbered. */
interface AnnotationTally {
  skippedDimensions: number; skippedGuides: number; skippedPlanes: number; rays: number; unnamedPlanes: number; numberPlanes: boolean;
}

/** Section planes, guides and dimensions, in the definition's own coordinates. */
function convertAnnotations(source: Definition, result: ImportedDefinition, tally: AnnotationTally): void {
  const point = (p: readonly number[] | null | undefined): Vec3 | null =>
    p && p.length === 3 && p.every(Number.isFinite) ? [p[0]! * INCH, p[1]! * INCH, p[2]! * INCH] : null;
  const unit = (v: readonly number[] | null | undefined): Vec3 | null =>
    v && v.length === 3 && v.every(Number.isFinite) && v3len(v as Vec3) > LENGTH_TOL ? v3normalize(v as Vec3) : null;
  // A section plane's rectangle is drawn around the definition's own geometry.
  let center: Vec3 = [0, 0, 0];
  if (source.vertices.length) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const v of source.vertices) [v.x, v.y, v.z].forEach((c, i) => { min[i] = Math.min(min[i]!, c); max[i] = Math.max(max[i]!, c); });
    if ([...min, ...max].every(Number.isFinite)) center = [(min[0]! + max[0]!) / 2 * INCH, (min[1]! + max[1]!) / 2 * INCH, (min[2]! + max[2]!) / 2 * INCH];
  }
  let active = false;
  for (const sp of source.sectionPlanes as ReaderSectionPlane[]) {
    const [a, b, c, d] = sp.plane, length = Math.hypot(a, b, c);
    if (![a, b, c, d].every(Number.isFinite) || length <= LENGTH_TOL) { tally.skippedPlanes++; continue; }
    // The .skp format stores a plane as a·x + b·y + c·z + d = 0 in inches.
    const plane: Plane = { n: [a / length, b / length, c / length], d: d / length * INCH };
    // Files older than SketchUp 2018 store no section plane names; they are numbered, model first.
    const number = tally.numberPlanes && !sp.name && !sp.label ? ++tally.unnamedPlanes : null;
    result.sectionPlanes.push({ name: number ? `Section ${number}` : sp.name, symbol: number ? String(number) : sp.label,
      plane, hidden: sp.hidden, tag: sp.layer ?? '', active: !!sp.active && !active,
      origin: v3sub(center, v3scale(plane.n, v3dot(plane.n, center) + plane.d)) });
    active ||= !!sp.active;
  }
  for (const line of source.constructionLines as ReaderGuideLine[]) {
    const attrs = { hidden: line.hidden ?? false, tag: line.layer ?? '' };
    const start = point(line.start), end = point(line.end), dir = unit(line.direction);
    if (line.start && line.end) {
      if (start && end && v3len(v3sub(end, start)) > LENGTH_TOL) result.guides.push({ ...attrs, kind: 'segment', origin: start, end });
      else tally.skippedGuides++;
      continue;
    }
    const origin = line.start ? start : line.end ? end : point(line.point);
    if (!origin || !dir) { tally.skippedGuides++; continue; }
    if (line.start || line.end) tally.rays++;
    result.guides.push({ ...attrs, kind: 'line', origin, dir });
  }
  for (const guide of source.constructionPoints as ReaderGuidePoint[]) {
    const origin = point(guide.position);
    if (origin) result.guides.push({ hidden: guide.hidden ?? false, tag: guide.layer ?? '', kind: 'point', origin });
    else tally.skippedGuides++;
  }
  for (const dim of source.dimensions as ReaderDimension[]) {
    const start = point(dim.a), b = point(dim.b), normal = unit(dim.normal), x = unit(dim.planeX);
    if (!start || !b || !normal || !x || !Number.isFinite(dim.offset)) { tally.skippedDimensions++; continue; }
    // A dimension measures along its plane's X or Y axis, or between its points, within its plane.
    const delta = v3sub(b, start);
    const base = dim.alignment === 1 ? x : dim.alignment === 2 ? v3cross(normal, x) : delta;
    const axis = unit(v3sub(base, v3scale(normal, v3dot(base, normal))));
    const length = axis ? v3dot(delta, axis) : 0;
    if (!axis || Math.abs(length) <= LENGTH_TOL) { tally.skippedDimensions++; continue; }
    result.dimensions.push({ start, end: v3add(start, v3scale(axis, length)), normal,
      offset: v3scale(v3cross(normal, axis), dim.offset * INCH), text: dim.text || null, hidden: dim.hidden, tag: dim.layer ?? '' });
  }
}

/**
 * Leader text keeps its anchor and label offset; screen text keeps its position as fractions of the view.
 * A pushpin leader's vector is a world offset. A view-based leader's vector holds its offset along the view's
 * right and up directions (SketchUp's Text#vector is that offset in the camera the model opens with), so it is kept
 * as a view offset. Fonts, the material's color and the arrow come with the text. Text whose anchor
 * the reader does not resolve is reported and skipped.
 */
function convertTexts(source: Definition, warn: (m: string) => void, materials: ReadonlyMap<number, ImportedMaterial>): ImportedText[] {
  const texts: ImportedText[] = [];
  let skipped = 0;
  for (const text of source.texts) {
    const font = text.font && text.font.name ? { family: text.font.name, sizePt: text.font.size > 0 ? text.font.size : 12, bold: text.font.bold, italic: text.font.italic } : null;
    const color = text.materialId !== null ? materials.get(text.materialId)?.color : undefined;
    const arrow = text.arrowType !== null ? TEXT_ARROWS[text.arrowType] : undefined;
    const common = { text: text.text, hidden: text.hidden, tag: text.layer, ...(font ? { font } : {}), ...(color ? { color: [...color] as Vec3 } : {}) };
    if (text.leaderType === 0 && text.screen && text.screen.every(Number.isFinite)) {
      texts.push({ ...common, kind: 'screen', position: [text.screen[0], text.screen[1], 0], offset: null, leader: 'none' });
    } else if (text.point && text.point.every(Number.isFinite)) {
      const vector = text.vector && text.vector.every(Number.isFinite) ? text.vector : null;
      const view = text.leaderType === 1;
      texts.push({ ...common, kind: 'leader', position: [text.point[0] * INCH, text.point[1] * INCH, text.point[2] * INCH],
        offset: !view && vector ? [vector[0] * INCH, vector[1] * INCH, vector[2] * INCH] : null,
        ...(view && vector ? { viewOffset: [vector[0] * INCH, vector[1] * INCH] as [number, number] } : {}),
        leader: !text.displayLeader ? 'none' : view ? 'view' : 'pushpin', ...(arrow ? { arrow } : {}) });
    } else skipped++;
  }
  if (skipped) warn(`${source.name || 'Model'}: ${skipped} text(s) skipped: their position could not be recovered.`);
  return texts;
}

/** A TIFF in either byte order, by its leading bytes. */
function isTiff(data: Uint8Array): boolean {
  return data.length >= 8 && ((data[0] === 0x49 && data[1] === 0x49 && data[2] === 42 && data[3] === 0) || (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0 && data[3] === 42));
}

/** MIME type of a texture image the app can display, from its leading bytes, or null. */
function imageMime(data: Uint8Array): string | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  // SketchUp 5 stores some textures as Windows bitmaps; browsers and the desktop webviews decode them.
  if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  return null;
}

/**
 * The texture frame the .skp format uses for a plane normal: x = normalize(Z × n), y = n × x. A plane facing
 * up or down, within tolerance, has x = ±X instead;
 * PushForm's own face basis differs from it for faces facing down.
 */
function textureFrame(n: Vec3): [Vec3, Vec3] {
  const horizontal = Math.hypot(n[0], n[1]);
  const x: Vec3 = horizontal <= SKETCHUP_VERTICAL_TEXTURE_TOL ? [n[2] < 0 ? -1 : 1, 0, 0] : [-n[1] / horizontal, n[0] / horizontal, 0];
  return [x, v3cross(n, x)];
}

function invert3(m: readonly number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || det === 0) return null;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det,
    (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}

/**
 * One face side's texture coordinates. SketchUp stores a 3×3 matrix from texture space (inches)
 * to the face's texture frame, or to the frame of the projection direction for projected
 * textures; with row vectors, uvq = [p·x, p·y, 1] · M⁻¹ and the tile coordinates are
 * (u/q, v/q) divided by the tile size. A distorted (four-pin) placement varies q across the face
 * and keeps it; otherwise q is constant on the face and divides the placement. Returns
 * a null map when the result equals PushForm's automatic mapping (face basis through the plane's
 * point nearest the origin, divided by the tile size), so default placements keep following the
 * material size. `source` is SketchUp's face normal, which sets the texture frame; `normal` is the
 * imported face's, which is the reverse of it on a reversed face.
 */
function sideUvMap(source: Vec3, transform: readonly number[] | null, projection: readonly number[] | null,
  texture: { widthM: number; heightM: number }, points: Vec3[], normal: Vec3): ImportedUvMap | null {
  const direction = projection?.length === 3 && projection.every(Number.isFinite) && v3len(projection as Vec3) > ANGLE_TOL
    ? v3normalize(projection as Vec3) : source;
  const [x, y] = textureFrame(direction);
  const inv = (transform?.length === 9 ? invert3(transform) : null) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // Row i of the placement as a plane function of the world point: column i of M⁻¹ over [p·x, p·y, 1] (inches).
  const row = (i: 0 | 1 | 2, scale: number): [number, number, number, number] => [
    (x[0] * inv[i]! + y[0] * inv[i + 3]!) * scale / INCH, (x[1] * inv[i]! + y[1] * inv[i + 3]!) * scale / INCH,
    (x[2] * inv[i]! + y[2] * inv[i + 3]!) * scale / INCH, inv[i + 6]! * scale];
  const at = (r: [number, number, number, number], p: Vec3): number => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3];
  const q = row(2, 1), q0 = at(q, points[0]!);
  const distorted = points.some(p => Math.abs(at(q, p) - q0) > RATIO_TOL * Math.abs(q0));
  const k = Number.isFinite(q0) && q0 !== 0 ? 1 / q0 : 1;
  const tileW = texture.widthM / INCH, tileH = texture.heightM / INCH;
  const map: ImportedUvMap = { s: row(0, k / tileW), t: row(1, k / tileH) };
  if (distorted) return { ...map, q: row(2, k) };
  // PushForm's automatic mapping: s = (p·u) / width, t = (p·v) / height in the face's own basis.
  const { u, v } = planeBasis([0, 0, 0], normal);
  return sameAxis(map.s, u, texture.widthM) && sameAxis(map.t, v, texture.heightM) ? null : map;
}

/** Whether a placement row is the automatic mapping's: `dir` divided by `size`, through the origin. */
function sameAxis(axis: [number, number, number, number], dir: Vec3, size: number): boolean {
  return Math.abs(axis[3]) <= RATIO_TOL && [0, 1, 2].every(k => Math.abs(axis[k]! - dir[k]! / size) <= RATIO_TOL / size);
}

/**
 * The placement of an inherited texture in the frame of its face normal `source`, in meters (sized, so
 * every texture size the face inherits is placed by its own size), or null where PushForm's automatic mapping of the
 * imported face's `normal` agrees with it.
 */
function defaultUvMap(source: Vec3, normal: Vec3): ImportedUvMap | null {
  const [x, y] = textureFrame(source);
  const map: ImportedUvMap = { s: [x[0], x[1], x[2], 0], t: [y[0], y[1], y[2], 0], sized: true };
  const { u, v } = planeBasis([0, 0, 0], normal);
  return sameAxis(map.s, u, 1) && sameAxis(map.t, v, 1) ? null : map;
}

/** Area a loop encloses, projected onto the plane with this normal (Newell's method). */
function loopArea(loop: Vec3[], normal: Vec3): number {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
    x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return Math.abs(v3dot([x, y, z], normal)) / 2;
}

function faceLoops(face: Face, edges: Map<number, Edge>, vertices: Map<number, Vec3>): Vec3[][] {
  if (!face.loops.length) throw new Error('missing boundary');
  return face.loops.map(loop => {
    if (loop.length < 3) throw new Error('boundary has fewer than three edges');
    return loop.map((ref, i) => {
      const e = edges.get(ref.edgeId), next = loop[(i + 1) % loop.length]!;
      const n = edges.get(next.edgeId);
      if (!e || !n) throw new Error('missing boundary edge');
      const start = ref.orientation === 1 ? e.v1Id : e.v2Id, end = ref.orientation === 1 ? e.v2Id : e.v1Id;
      if (end !== (next.orientation === 1 ? n.v1Id : n.v2Id)) throw new Error('disconnected boundary');
      const p = vertices.get(start);
      if (!p || !p.every(Number.isFinite)) throw new Error('missing or invalid boundary vertex');
      return p;
    });
  });
}
