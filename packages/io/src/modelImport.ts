// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { strFromU8, unzipSync } from 'fflate';
import { COLLADA_FORMAT, isXmlBytes, readCollada } from './collada';
import { isDxfBytes, isDxfFile, parseDxfHeader } from './dxf';
import { DXF_FORMAT, readDxf } from './dxfModel';
import { GLTF_FORMAT, isGlbBytes, isGltfJson, isGltfModelFile, readGltf } from './gltf';
import { isZipBytes, normalizePath, unpackModelArchive, type MeshExtent, type MeshImportOptions } from './meshImport';
import { OBJ_FORMAT, isObjModelFile, isObjText, objExtent, readObj } from './obj';
import { SKETCHUP_FORMAT, isSketchUpModelFile, readSketchUp, type ImportFormat, type ImportProgress, type SketchUpImport } from './sketchup';
import { STEP_FORMAT, isStepBytes, isStepModelFile, readStep } from './step';
import { STL_FORMAT, isStlBytes, isStlModelFile, readStl, stlExtent } from './stl';
import { THREE_DS_FORMAT, is3dsBytes, is3dsModelFile, read3ds, threeDsExtent } from './threeDs';

/**
 * Model files Open… and Import… convert: SketchUp (`.skp`, `.skb`), COLLADA (`.dae`), OBJ (`.obj`), 3DS (`.3ds`), STL
 * (`.stl`), DXF (`.dxf`), glTF (`.gltf`, `.glb`), STEP (`.step`, `.stp`), and `.zip` or `.kmz` archives holding a COLLADA, OBJ,
 * 3DS or glTF model
 * with its materials and images.
 */
export function isModelImportFile(name: string): boolean { return isSketchUpModelFile(name) || /\.(dae|zip|kmz|obj|3ds|stl|dxf|gltf|glb|step|stp)$/i.test(name); }

/** Pictures Import… places in a model as images, by extension, with the MIME type their bytes are stored under. */
const PICTURE_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
/** The largest picture Import… places. */
export const MAX_PICTURE_BYTES = 32 * 1024 * 1024;
/** The MIME type of a picture file Import… places, or null when the name is not one. */
export function pictureMime(name: string): string | null { return PICTURE_TYPES[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''] ?? null; }
export function isPictureFile(name: string): boolean { return pictureMime(name) !== null; }

/** The format a model import file name names, for messages, undo labels and import reports; archives read as COLLADA until opened. */
export function modelImportFormat(name: string): ImportFormat {
  return isObjModelFile(name) ? OBJ_FORMAT : is3dsModelFile(name) ? THREE_DS_FORMAT : isStlModelFile(name) ? STL_FORMAT
    : isDxfFile(name) ? DXF_FORMAT : isGltfModelFile(name) ? GLTF_FORMAT : isStepModelFile(name) ? STEP_FORMAT : /\.(dae|zip|kmz)$/i.test(name) ? COLLADA_FORMAT : SKETCHUP_FORMAT;
}

/** The file name without its model import extension, for the converted `.pf` and the imported group. */
export function modelImportBaseName(name: string): string { return name.replace(/\.(skp|skb|dae|zip|kmz|obj|3ds|stl|dxf|gltf|glb|step|stp)$/i, ''); }

/**
 * Formats whose files record neither their unit nor, for OBJ and STL, their up axis, so import asks; DXF only
 * when unitless.
 */
export type MeshFormatKind = 'obj' | '3ds' | 'stl' | 'dxf';
/** Mesh formats whose import asks which axis is up. */
export const MESH_FORMATS_WITH_UP_AXIS: readonly MeshFormatKind[] = ['obj', 'stl'];
/**
 * Defaults before a choice is remembered: OBJ in meters with Y up, as most OBJ exporters write; 3DS in millimeters
 * (always Z up); STL in millimeters with Z up, as 3D-printing files are; a unitless DXF in millimeters (always Z up).
 */
export const DEFAULT_MESH_OPTIONS: Readonly<Record<MeshFormatKind, MeshImportOptions>> = {
  obj: { unit: 'm', up: 'y' }, '3ds': { unit: 'mm', up: 'z' }, stl: { unit: 'mm', up: 'z' }, dxf: { unit: 'mm', up: 'z' },
};

/** The model an archive holds: the `.dae` a `.kmz`'s `doc.kml` links to, else the first COLLADA, then OBJ, then 3DS, then glTF model by path. */
function archiveModel(names: string[], kml: { path: string; text: string } | null): { path: string; others: number } | null {
  const models = names.filter(name => /\.(dae|obj|3ds|gltf|glb)$/i.test(name)).sort();
  let chosen: string | undefined;
  if (kml !== null) {
    const href = /<Model\b[\s\S]*?<Link\b[\s\S]*?<href>\s*([^<]*?)\s*<\/href>/i.exec(kml.text)?.[1];
    const target = href ? normalizePath(`${kml.path.split('/').slice(0, -1).join('/')}/${decodeURIComponent(href)}`) : undefined;
    chosen = models.find(name => name === target) ?? models.find(name => name.toLowerCase() === target?.toLowerCase());
  }
  chosen ??= models.find(name => /\.dae$/i.test(name)) ?? models.find(name => /\.obj$/i.test(name)) ?? models.find(name => /\.3ds$/i.test(name))
    ?? models.find(name => /\.(gltf|glb)$/i.test(name));
  return chosen ? { path: chosen, others: models.length - 1 } : null;
}

/**
 * Read the model in a `.zip` or `.kmz` archive with the materials and images beside it. OBJ and 3DS
 * models are read with `options`, or their format's default.
 */
export async function readModelArchive(bytes: Uint8Array, onProgress?: (p: ImportProgress) => void, options?: MeshImportOptions): Promise<SketchUpImport> {
  onProgress?.({ stage: 'Unpacking archive', current: 0, total: 1 });
  const files = unpackModelArchive(bytes);
  const kmlPath = [...files.keys()].filter(name => /\.kml$/i.test(name)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
  const kml = kmlPath ? { path: kmlPath, text: strFromU8(files.get(kmlPath)!) } : null;
  const found = archiveModel([...files.keys()], kml);
  if (!found) throw new Error('No COLLADA, OBJ, 3DS or glTF model (.dae, .obj, .3ds, .gltf or .glb) was found in this archive.');
  const resources = { base: found.path.split('/').slice(0, -1).join('/'), files }, model = files.get(found.path)!;
  const scene = /\.obj$/i.test(found.path) ? await readObj(model, options ?? DEFAULT_MESH_OPTIONS.obj, onProgress, resources)
    : /\.3ds$/i.test(found.path) ? await read3ds(model, options ?? DEFAULT_MESH_OPTIONS['3ds'], onProgress, resources)
    : /\.(gltf|glb)$/i.test(found.path) ? await readGltf(model, onProgress, resources)
    : await readCollada(model, onProgress, resources);
  if (found.others) scene.warnings.push(`${found.others} other model${found.others === 1 ? ' in the archive is' : 's in the archive are'} not imported.`);
  if (kml !== null) scene.warnings.push('The Google Earth location of a .kmz model is not imported.');
  return scene;
}

/**
 * Whether reading these bytes asks for mesh import options, and the model's extent in its own units for the size
 * preview: OBJ and 3DS files, and archives whose model is one.
 */
export function probeMeshImport(bytes: Uint8Array): { kind: MeshFormatKind; extent: MeshExtent | null } | null {
  if (isZipBytes(bytes)) {
    let model: Record<string, Uint8Array>;
    try { model = unzipSync(bytes, { filter: file => /\.(dae|obj|3ds|gltf|glb|kml)$/i.test(file.name) && !/(^|\/)__MACOSX\//.test(file.name) }); } catch { return null; }
    const names = Object.keys(model).map(normalizePath), kmlName = Object.keys(model).find(name => /\.kml$/i.test(name));
    const found = archiveModel(names, kmlName ? { path: normalizePath(kmlName), text: strFromU8(model[kmlName]!) } : null);
    const data = found ? Object.entries(model).find(([name]) => normalizePath(name) === found.path)?.[1] : undefined;
    // COLLADA and glTF files record their unit and up axis.
    if (!found || !data || /\.(dae|gltf|glb)$/i.test(found.path)) return null;
    return /\.obj$/i.test(found.path) ? { kind: 'obj', extent: objExtent(data) } : { kind: '3ds', extent: threeDsExtent(data) };
  }
  if (isGlbBytes(bytes) || isGltfJson(bytes) || isStepBytes(bytes)) return null;
  if (is3dsBytes(bytes)) return { kind: '3ds', extent: threeDsExtent(bytes) };
  if (isStlBytes(bytes)) return { kind: 'stl', extent: stlExtent(bytes) };
  if (isDxfBytes(bytes)) {
    // A DXF that records its units imports in them without asking.
    const header = parseDxfHeader(bytes);
    return header.units ? null : { kind: 'dxf', extent: header.extent };
  }
  if (!isXmlBytes(bytes) && isObjText(bytes)) return { kind: 'obj', extent: objExtent(bytes) };
  return null;
}

/**
 * Read model bytes of any supported format, told apart by their content: COLLADA is XML, archives are zip files, 3DS
 * starts with its main chunk, binary glTF with `glTF` and JSON glTF with `{`, STEP with `ISO-10303-21;`, a binary STL's
 * triangle count fits its size and an ASCII STL starts with `solid`, DXF starts with a SECTION group, OBJ with an OBJ
 * statement, and anything else is read as a .skp file.
 */
export function readModelImport(bytes: Uint8Array, onProgress?: (p: ImportProgress) => void, options?: MeshImportOptions): Promise<SketchUpImport> {
  if (isXmlBytes(bytes)) return readCollada(bytes, onProgress);
  if (isZipBytes(bytes)) return readModelArchive(bytes, onProgress, options);
  if (is3dsBytes(bytes)) return read3ds(bytes, options ?? DEFAULT_MESH_OPTIONS['3ds'], onProgress);
  if (isGlbBytes(bytes) || isGltfJson(bytes)) return readGltf(bytes, onProgress);
  if (isStepBytes(bytes)) return readStep(bytes, onProgress);
  if (isStlBytes(bytes)) return readStl(bytes, options ?? DEFAULT_MESH_OPTIONS.stl, onProgress);
  if (isDxfBytes(bytes)) return readDxf(bytes, options ?? DEFAULT_MESH_OPTIONS.dxf, onProgress);
  if (isObjText(bytes)) return readObj(bytes, options ?? DEFAULT_MESH_OPTIONS.obj, onProgress);
  return readSketchUp(bytes, onProgress);
}
