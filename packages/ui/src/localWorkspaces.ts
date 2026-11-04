// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** The caller supplies account-scoped local storage; records never cross account namespaces. */
export const LOCAL_WORKSPACES_KEY = 'pushform:local-workspaces:v1';
export interface LocalWorkspace { scope: string; names: string[]; touched: number }
export type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem'>;
export function localWorkspaces(storage: WorkspaceStorage): LocalWorkspace[] {
  const raw = storage.getItem(LOCAL_WORKSPACES_KEY); if (!raw) return [];
  if (raw.length > 2 * 1024 * 1024) throw new Error('The local workspace index is too large.');
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.length > 2000 || rows.some(row => !row || typeof row.scope !== 'string' || !/^[a-zA-Z0-9-]{1,256}$/.test(row.scope) || !Number.isFinite(row.touched) || !Array.isArray(row.names) || row.names.some((name: unknown) => typeof name !== 'string' || name.length > 200))) throw new Error('The local workspace index could not be read.');
  return rows as LocalWorkspace[];
}
export function rememberLocalWorkspace(storage: WorkspaceStorage, scope: string, names: string[]): void {
  const rows = localWorkspaces(storage).filter(row => row.scope !== scope);
  if (names.length) rows.unshift({ scope, names: names.map(name => name.slice(0,200)), touched: Date.now() });
  if (rows.length > 2000) throw new Error('The local workspace index is full. Save or recover earlier workspaces.');
  const encoded = JSON.stringify(rows);
  if (encoded.length > 2 * 1024 * 1024) throw new Error('The local workspace index is full.');
  storage.setItem(LOCAL_WORKSPACES_KEY, encoded);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pushform:local-workspaces'));
}
