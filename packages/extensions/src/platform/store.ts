// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ExtensionManifest, ExtensionPermission } from '@pushform/extension-protocol';

/**
 * An installed extension, as kept on this device: the verified package (manifest and files), how it was installed,
 * whether it is enabled, and what the user granted. Side-loaded developer extensions exist only here; they are
 * never synced to the account or shared.
 */
export interface InstalledExtension {
  readonly id: string;
  readonly version: string;
  readonly manifest: ExtensionManifest;
  readonly files: Readonly<Record<string, Uint8Array>>;
  /** SHA-256 of the manifest: the release's content address. */
  readonly contentHash: string;
  readonly integrity: 'official' | 'unsigned';
  readonly source: 'developer' | 'registry';
  readonly enabled: boolean;
  readonly grants: readonly ExtensionPermission[];
  readonly installedAt: string;
}

export interface ExtensionStore {
  list(): Promise<InstalledExtension[]>;
  put(record: InstalledExtension): Promise<void>;
  delete(id: string): Promise<void>;
}

export function memoryExtensionStore(initial: readonly InstalledExtension[] = []): ExtensionStore {
  const records = new Map(initial.map((r) => [r.id, r] as const));
  return {
    list: async () => [...records.values()],
    put: async (record) => { records.set(record.id, record); },
    delete: async (id) => { records.delete(id); },
  };
}
