// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Import reports: one row per attempt to import a SketchUp, COLLADA, OBJ, 3DS, STL or DXF model or a
 * LayOut document, successful or not, so imported files, their sizes, the version (or COLLADA authoring tool) that
 * wrote them, their creation and modification times, and every conversion issue can be counted.
 */
import type { RpcArgs } from './rpc';
export type CloudImportSource = 'sketchup_model' | 'sketchup_layout' | 'collada_model' | 'obj_model' | '3ds_model' | 'stl_model' | 'dxf_model' | 'gltf_model';
export type CloudImportStatus = 'imported' | 'failed' | 'cancelled';

export interface CloudImportReport {
  source: CloudImportSource;
  status: CloudImportStatus;
  fileName: string;
  /** Size of the picked file in bytes, when it was read. */
  sizeBytes: number | null;
  /** Wall-clock time from picking the file to the outcome. */
  durationMs: number | null;
  /** The SketchUp or LayOut version that saved the file, such as `26.2.242`. */
  sourceVersion: string | null;
  /** Creation and last-modified times stored inside the file (LayOut documents carry both). ISO 8601. */
  sourceCreatedAt: string | null;
  sourceModifiedAt: string | null;
  /** The file system's last-modified time for the picked file. ISO 8601. */
  fileModifiedAt: string | null;
  /** Converted-content counts, such as bodies, instances, materials or pages. */
  counts: Record<string, number>;
  /** Every conversion limitation or warning, one entry per distinct message. */
  issues: string[];
  /** The failure message for a failed import. */
  error: string | null;
  appVersion: string | null;
  appBuild: string | null;
}

/** The stored row, as `cloud_record_import` returns it. */
export interface CloudImportRecord {
  id: string; owner_id: string; created_at: string; source: CloudImportSource; status: CloudImportStatus;
  file_name: string; size_bytes: number | null; duration_ms: number | null; source_version: string | null;
  source_created_at: string | null; source_modified_at: string | null; file_modified_at: string | null;
  counts: Record<string, number>; issues: string[]; error: string | null; app_version: string | null; app_build: string | null;
}

export const IMPORT_FILE_NAME_LIMIT = 500;
export const IMPORT_ISSUE_LIMIT = 200;
export const IMPORT_ISSUE_LENGTH = 1000;
export const IMPORT_ERROR_LENGTH = 2000;
export const IMPORT_VERSION_LENGTH = 100;
export const IMPORT_COUNT_LIMIT = 50;

function clean(value: string | null | undefined, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\p{Cc}+/gu, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
function isoDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function wholeNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * Normalize a report into the RPC parameters: strings trimmed and bounded, dates as ISO 8601,
 * counts restricted to finite non-negative integers, and issues deduplicated in order. The SQL
 * function enforces the same bounds, so a report that passes here is accepted by the server.
 */
export function cloudImportParams(report: CloudImportReport): RpcArgs<'cloud_record_import'> {
  if (!['sketchup_model', 'sketchup_layout', 'collada_model', 'obj_model', '3ds_model', 'stl_model', 'dxf_model', 'gltf_model'].includes(report.source)) throw new Error('Unknown import source.');
  if (!['imported', 'failed', 'cancelled'].includes(report.status)) throw new Error('Unknown import status.');
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(report.counts ?? {})) {
    const count = wholeNumber(value), name = clean(key, 60);
    if (count !== null && name && Object.keys(counts).length < IMPORT_COUNT_LIMIT) counts[name] = count;
  }
  const issues: string[] = [];
  for (const issue of report.issues ?? []) {
    const text = clean(issue, IMPORT_ISSUE_LENGTH);
    if (text && !issues.includes(text) && issues.length < IMPORT_ISSUE_LIMIT) issues.push(text);
  }
  return {
    p_source: report.source, p_status: report.status,
    p_file_name: clean(report.fileName, IMPORT_FILE_NAME_LIMIT) ?? 'Untitled',
    p_size_bytes: wholeNumber(report.sizeBytes), p_duration_ms: wholeNumber(report.durationMs),
    p_source_version: clean(report.sourceVersion, IMPORT_VERSION_LENGTH),
    p_source_created_at: isoDate(report.sourceCreatedAt), p_source_modified_at: isoDate(report.sourceModifiedAt),
    p_file_modified_at: isoDate(report.fileModifiedAt),
    p_counts: counts, p_issues: issues, p_error: clean(report.error, IMPORT_ERROR_LENGTH),
    p_app_version: clean(report.appVersion, IMPORT_VERSION_LENGTH), p_app_build: clean(report.appBuild, IMPORT_VERSION_LENGTH),
  };
}
