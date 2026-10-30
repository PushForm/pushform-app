// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DefId } from '@pushform/core';
import type { CloudFilesApi } from '@pushform/cloud';
import { createDocument, ImageStore } from '@pushform/model';
import {
  applySketchUpImport, encodeLayoutSnapshot, encodeModelSnapshot, modelArchiveImages, importSketchUpLayoutInWorker,
  isModelImportFile, isSketchUpLayoutFile, modelImportBaseName, modelImportFormat, readSketchUpInWorker, LAYOUT_FILE_EXTENSION, MAX_SKETCHUP_BYTES,
  MODEL_FILE_EXTENSION, SKETCHUP_LAYOUT_EXTENSION, probeMeshImport,
  type ImportProgress, type MeshImportOptions, type ModelImportReport, type SketchUpImport, type SketchUpLayoutProperties,
} from '@pushform/io';
import type { BuildInfo } from './buildInfo';
import { importClock, layoutImportReport, logImport, modelImportReport, type ImportSource } from './importLog';
import { rememberedMeshOptions } from './meshImportOptions';
import type { DocumentSession, LayoutTab, ModelTab } from './session';

/** The parts of a browser File the import log records; absent on the desktop path, which reads bytes by path. */
export interface PickedFile { size?: number | undefined; lastModified?: number | undefined }

export interface ImportOptions {
  cloudFiles?: CloudFilesApi | undefined;
  buildInfo?: BuildInfo | undefined;
  picked?: PickedFile | undefined;
}

export const IMPORT_FILE_ACCEPT = '.skp,.skb,.dae,.obj,.3ds,.stl,.dxf,.gltf,.glb,.zip,.kmz,.layout';
export const IMPORT_FILE_DESCRIPTION = 'Choose .skp, .skb, .dae, .obj, .3ds, .stl, .dxf, .gltf, .glb, .zip, .kmz, or .layout files.';

export function isImportableFile(name: string): boolean {
  return isModelImportFile(name) || isSketchUpLayoutFile(name);
}

/** The size limit message for a model file. */
export function tooLarge(name: string): string {
  return `${modelImportFormat(name).name} files larger than 128 MiB are not supported yet.`;
}

/**
 * Convert SketchUp, COLLADA, OBJ or 3DS model bytes into a new tab, or into `target` when importing into an open model.
 * Every attempt stores an import report, including cancellation and failure.
 */
export async function importSketchUpBytes(
  session: DocumentSession, bytes: Uint8Array, name: string,
  options: ImportOptions & {
    target?: { tabId: string; definitionId: DefId } | undefined;
    signal?: AbortSignal | undefined;
    onProgress?: ((progress: ImportProgress) => void) | undefined;
    /** How to read an OBJ or 3DS file's unit and up axis. */
    mesh?: MeshImportOptions | undefined;
  } = {},
): Promise<{ tab: ModelTab; report: ModelImportReport }> {
  const source: ImportSource = { fileName: name, sizeBytes: bytes.byteLength, startedAt: importClock(), fileModifiedAt: options.picked?.lastModified };
  let scene: SketchUpImport | null = null;
  try {
    if (bytes.byteLength > MAX_SKETCHUP_BYTES) throw new Error(tooLarge(name));
    scene = await readSketchUpInWorker(bytes, { mesh: options.mesh,
      ...(options.signal ? { signal: options.signal } : {}), ...(options.onProgress ? { onProgress: options.onProgress } : {}) });
    if (options.signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    const target = options.target;
    const result = target
      ? { tab: session.tabs.find(t => t.id === target.tabId) as ModelTab, report: session.importSketchUpModel(scene, name, target.tabId, target.definitionId) }
      : session.openSketchUpModel(scene, name);
    void logImport(options.cloudFiles, modelImportReport(source, { scene, report: result.report }, options.buildInfo));
    return result;
  } catch (cause) {
    void logImport(options.cloudFiles, modelImportReport(source, { scene, error: cause }, options.buildInfo), bytes);
    throw cause;
  }
}

/**
 * Convert a LayOut document into a new tab; every attempt stores an import report.
 * The session still converts on the main thread here; `convertImportFile` already prepares in a worker.
 */
export async function importLayoutBytes(
  session: DocumentSession, bytes: Uint8Array, name: string, options: ImportOptions = {},
): Promise<{ tab: LayoutTab; warnings: string[]; properties: SketchUpLayoutProperties }> {
  const source: ImportSource = { fileName: name, sizeBytes: bytes.byteLength, startedAt: importClock(), fileModifiedAt: options.picked?.lastModified };
  try {
    // Inflation, XML and vector conversion run in a disposable worker; only the document is installed here.
    const result = session.importSketchUpLayout(await importSketchUpLayoutInWorker(bytes, name), name);
    void logImport(options.cloudFiles, layoutImportReport(source, { properties: result.properties, warnings: result.warnings,
      pages: result.tab.doc.state.pageOrder.length }, options.buildInfo));
    return result;
  } catch (cause) {
    void logImport(options.cloudFiles, layoutImportReport(source, { error: cause }, options.buildInfo), bytes);
    throw cause;
  }
}

/** A picked file converted to native bytes without opening a tab, ready to upload. */
export interface ConvertedImport {
  kind: 'model' | 'layout';
  /** The native file name, `<source base>.pf` or `.pfl`. */
  name: string;
  bytes: Uint8Array;
  /** Conversion limitations, as the editor's import dialogs list them. */
  notes: string[];
}

/**
 * Convert a SketchUp, COLLADA, OBJ or 3DS model or a LayOut document to PushForm bytes. Nothing is opened in the editor;
 * every attempt still stores an import report.
 */
export async function convertImportFile(
  file: File, options: Omit<ImportOptions, 'picked'> & { signal?: AbortSignal | undefined; onProgress?: ((progress: ImportProgress) => void) | undefined } = {},
): Promise<ConvertedImport> {
  if (!isImportableFile(file.name)) throw new Error(IMPORT_FILE_DESCRIPTION);
  if (isModelImportFile(file.name) && file.size > MAX_SKETCHUP_BYTES) throw new Error(tooLarge(file.name));
  const bytes = new Uint8Array(await file.arrayBuffer());
  const source: ImportSource = { fileName: file.name, sizeBytes: bytes.byteLength, startedAt: importClock(), fileModifiedAt: file.lastModified };
  if (isModelImportFile(file.name)) {
    let scene: SketchUpImport | null = null;
    try {
      // Several files import at once without asking, so OBJ, 3DS and unitless DXF files use the options last chosen.
      const probe = probeMeshImport(bytes);
      scene = await readSketchUpInWorker(bytes, { mesh: probe ? rememberedMeshOptions(probe.kind) : undefined,
        ...(options.signal ? { signal: options.signal } : {}), ...(options.onProgress ? { onProgress: options.onProgress } : {}) });
      if (options.signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
      const doc = createDocument(), images = new ImageStore();
      const report = doc.transact(`Import ${modelImportFormat(file.name).name} model`, draft => applySketchUpImport(draft, scene!, { images })).value;
      const converted = await encodeModelSnapshot(doc.state, modelArchiveImages(doc.state, images));
      void logImport(options.cloudFiles, modelImportReport(source, { scene, report }, options.buildInfo));
      return { kind: 'model', name: `${modelImportBaseName(file.name)}${MODEL_FILE_EXTENSION}`, bytes: converted, notes: report.warnings };
    } catch (cause) {
      void logImport(options.cloudFiles, modelImportReport(source, { scene, error: cause }, options.buildInfo), bytes);
      throw cause;
    }
  }
  try {
    // Inflation, XML parsing and vector conversion run in a disposable worker; only the prepared state returns.
    const { doc, warnings, properties } = await importSketchUpLayoutInWorker(bytes, file.name, options.signal ? { signal: options.signal } : {});
    const converted = await encodeLayoutSnapshot(doc.state);
    void logImport(options.cloudFiles, layoutImportReport(source, { properties, warnings, pages: doc.state.pageOrder.length }, options.buildInfo));
    return { kind: 'layout', name: `${file.name.slice(0, -SKETCHUP_LAYOUT_EXTENSION.length)}${LAYOUT_FILE_EXTENSION}`, bytes: converted, notes: warnings };
  } catch (cause) {
    void logImport(options.cloudFiles, layoutImportReport(source, { error: cause }, options.buildInfo), bytes);
    throw cause;
  }
}
