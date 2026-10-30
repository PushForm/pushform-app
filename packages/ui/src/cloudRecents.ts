// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CloudFile } from '@pushform/cloud';

/** Account-scoped metadata only; file contents and authorization stay on the server. */
export function readCloudRecents(ownerId: string): CloudFile[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`pushform:recent:${ownerId}`) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is CloudFile => item && typeof item.id === 'string' &&
      typeof item.project_id === 'string' && typeof item.name === 'string' && (item.kind === 'model' || item.kind === 'layout')).slice(0, 12) : [];
  } catch { return []; }
}
export function recordCloudRecent(ownerId: string, file: CloudFile): CloudFile[] {
  const files = [file, ...readCloudRecents(ownerId).filter(item => item.id !== file.id)].slice(0, 12);
  try { localStorage.setItem(`pushform:recent:${ownerId}`, JSON.stringify(files)); } catch { /* Optional browsing history. */ }
  return files;
}
/** Drop files that are gone or in the Trash. */
export function forgetCloudRecents(ownerId: string, ids: Iterable<string>): CloudFile[] {
  const gone = new Set(ids);
  const files = readCloudRecents(ownerId).filter(item => !gone.has(item.id));
  try { localStorage.setItem(`pushform:recent:${ownerId}`, JSON.stringify(files)); } catch { /* Optional metadata cache. */ }
  return files;
}
export function updateCloudRecent(ownerId: string, file: CloudFile): CloudFile[] {
  const existing = readCloudRecents(ownerId);
  if (!existing.some(item => item.id === file.id)) return recordCloudRecent(ownerId, file);
  const files = existing.map(item => item.id === file.id ? file : item);
  try { localStorage.setItem(`pushform:recent:${ownerId}`, JSON.stringify(files)); } catch { /* Optional metadata cache. */ }
  return files;
}
