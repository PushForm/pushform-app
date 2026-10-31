// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CloudFilesApi, CloudImportReport } from '@pushform/cloud';
import { modelImportFormat, type ModelImportReport, type SketchUpImport, type SketchUpLayoutProperties } from '@pushform/io';
import type { BuildInfo } from './buildInfo';

/** What the top bar knows about the picked file before conversion starts. */
export interface ImportSource {
  fileName: string;
  sizeBytes: number | null;
  /** `performance.now()` when the file was picked. */
  startedAt: number;
  /** The file system's last-modified time in epoch milliseconds, when the browser supplied a File. */
  fileModifiedAt?: number | null | undefined;
}

export function importClock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function outcome(error: unknown): { status: CloudImportReport['status']; error: string | null } {
  if (error === undefined) return { status: 'imported', error: null };
  if ((error as { name?: string } | null)?.name === 'AbortError') return { status: 'cancelled', error: null };
  const message = error instanceof Error ? error.message : String(error);
  return { status: 'failed', error: message || 'Import failed.' };
}

function common(source: ImportSource, build: BuildInfo | undefined): Pick<CloudImportReport, 'fileName' | 'sizeBytes' | 'durationMs' | 'fileModifiedAt' | 'appVersion' | 'appBuild'> {
  const modified = source.fileModifiedAt;
  return {
    fileName: source.fileName, sizeBytes: source.sizeBytes, durationMs: Math.max(0, importClock() - source.startedAt),
    fileModifiedAt: typeof modified === 'number' && Number.isFinite(modified) && modified > 0 ? new Date(modified).toISOString() : null,
    appVersion: build?.version ?? null, appBuild: build?.commit ?? null,
  };
}

/** SketchUp headers carry the version as `{26.2.242}`; the braces are container syntax, not part of the version. */
export function sketchUpVersion(version: string | null | undefined): string | null {
  const text = version?.replace(/^\s*\{|\}\s*$/g, '').trim();
  return text ? text : null;
}

/** The report source of each model format; an archive reports the format of the model it held. */
const MODEL_SOURCES = { sketchup: 'sketchup_model', collada: 'collada_model', obj: 'obj_model', '3ds': '3ds_model', stl: 'stl_model', dxf: 'dxf_model', gltf: 'gltf_model', step: 'step_model' } as const;

/**
 * A `.skp`/`.skb`, COLLADA, OBJ, 3DS, STL, DXF, glTF or STEP outcome: the scene gives the saving version (a COLLADA file's version and authoring
 * tool); the report gives counts and warnings.
 */
export function modelImportReport(
  source: ImportSource, result: { scene?: SketchUpImport | null; report?: ModelImportReport | undefined; error?: unknown },
  build?: BuildInfo,
): CloudImportReport {
  const { status, error } = outcome(result.error);
  const report = result.report;
  return {
    ...common(source, build), source: MODEL_SOURCES[result.scene?.format?.kind ?? modelImportFormat(source.fileName).kind], status, error,
    sourceVersion: sketchUpVersion(result.scene?.version), sourceCreatedAt: null, sourceModifiedAt: null,
    counts: report ? { bodies: report.bodies, sheetFaces: report.sheetFaces, looseEdges: report.looseEdges, definitions: report.definitions,
      instances: report.instances, materials: report.materials, tags: report.tags, scenes: report.scenes,
      sectionPlanes: report.sectionPlanes, guides: report.guides, dimensions: report.dimensions, texts: report.texts,
      ...(report.meshParts ? { meshParts: report.meshParts, meshPartTriangles: report.meshPartTriangles ?? 0 } : {}) } : {},
    issues: report?.warnings ?? result.scene?.warnings ?? [],
  };
}

/** A `.layout` outcome: document properties give the saving version and dates; warnings are the listed limitations. */
export function layoutImportReport(
  source: ImportSource, result: { properties?: SketchUpLayoutProperties | undefined; warnings?: string[] | undefined; pages?: number | undefined; error?: unknown },
  build?: BuildInfo,
): CloudImportReport {
  const { status, error } = outcome(result.error);
  const counts: Record<string, number> = {};
  if (result.pages !== undefined) counts.pages = result.pages;
  if (result.properties?.revision !== null && result.properties?.revision !== undefined) counts.sourceRevision = result.properties.revision;
  return {
    ...common(source, build), source: 'sketchup_layout', status, error,
    sourceVersion: result.properties?.version ?? null,
    sourceCreatedAt: result.properties?.created ?? null, sourceModifiedAt: result.properties?.modified ?? null,
    counts, issues: result.warnings ?? [],
  };
}

/**
 * Store a report without affecting the import: a missing cloud API or a failed write is noted in
 * the console only. The returned promise settles once the attempt finishes, for tests.
 */
export async function logImport(api: CloudFilesApi | undefined, report: CloudImportReport, bytes?: Uint8Array): Promise<void> {
  if (!api) return;
  try {
    const saved = await api.recordImport(report);
    if (report.status === 'failed' && bytes) await api.saveFailedImport?.(saved, bytes);
  }
  catch (cause) { console.warn('The import report was not stored.', cause); }
}
