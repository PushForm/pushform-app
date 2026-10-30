// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** The project and folder last chosen in the import dialog, per account and browser. */
export interface ImportDestination { projectId: string; folderId: string | null }

const key = (ownerId: string): string => `pushform:import-destination:${ownerId}`;

export function readImportDestination(ownerId: string): ImportDestination | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(ownerId)) ?? 'null');
    const item = value as { projectId?: unknown; folderId?: unknown } | null;
    if (!item || typeof item.projectId !== 'string' || !item.projectId) return null;
    return { projectId: item.projectId, folderId: typeof item.folderId === 'string' && item.folderId ? item.folderId : null };
  } catch { return null; }
}

export function writeImportDestination(ownerId: string, destination: ImportDestination): void {
  try { localStorage.setItem(key(ownerId), JSON.stringify(destination)); } catch { /* Optional convenience. */ }
}
