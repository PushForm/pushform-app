// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError, type ExtensionManifest } from '@pushform/extension-protocol';
import type { ServiceImplementations } from './host';

/**
 * An extension's settings: one JSON object, versioned by the manifest's settings version, starting from the
 * manifest's defaults. Official extensions keep them with the account (a cloud store), so they follow the user to
 * other devices; side-loaded developer extensions keep them on the device (a local store), never synced.
 *
 * Before a release activates, `prepare` brings stored settings up to the release's version by applying the
 * manifest's migration steps, without running extension code, and saves the result. Settings written by a newer
 * release are left untouched: the extension reads them with the defaults filling any gaps, and writing is refused
 * until that newer release is installed again, so an older release can never overwrite them.
 */

export interface StoredSettings {
  readonly version: number;
  readonly value: Record<string, unknown>;
  readonly revision: number;
}

/** Thrown by a store when the settings changed since the revision a save was based on. */
export class SettingsConflictError extends Error {
  constructor() {
    super('The settings changed since they were read.');
    this.name = 'SettingsConflictError';
  }
}

export interface SettingsStore {
  load(extensionId: string): Promise<StoredSettings | null>;
  /** Saves `value` based on `expectedRevision` (null when nothing is stored) and returns the new revision. */
  save(extensionId: string, version: number, value: Record<string, unknown>, expectedRevision: number | null): Promise<number>;
  remove(extensionId: string): Promise<boolean>;
}

/** The largest settings object, as UTF-8 JSON. */
export const SETTINGS_MAX_BYTES = 64 * 1024;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** The settings as JSON, after checking that they are a plain object of JSON values within the size bound. */
function encodeSettings(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ExtensionError('validation.failed', 'Settings must be a plain object.');
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new ExtensionError('validation.failed', 'Settings must contain only JSON values.');
  }
  if (new TextEncoder().encode(json).byteLength > SETTINGS_MAX_BYTES)
    throw new ExtensionError('limit.exceeded', `Settings are larger than ${SETTINGS_MAX_BYTES / 1024} KiB.`);
  return JSON.parse(json) as Record<string, unknown>;
}

/** Applies the manifest's migration steps to settings stored at `from`, up to the manifest's version. */
export function migrateSettings(manifest: ExtensionManifest, from: number, value: Record<string, unknown>): Record<string, unknown> {
  const declared = manifest.settings;
  if (!declared) return value;
  let current = { ...value };
  for (let version = from; version < declared.version; version++) {
    const step = declared.migrations?.find((m) => m.from === version);
    if (!step) continue; // No step for this version: the settings carry over unchanged.
    for (const [oldKey, newKey] of Object.entries(step.rename ?? {}))
      if (Object.hasOwn(current, oldKey)) {
        current[newKey] = current[oldKey];
        delete current[oldKey];
      }
    for (const key of step.remove ?? []) delete current[key];
    current = { ...current, ...structuredClone(step.set ?? {}) };
  }
  return current;
}

export class ExtensionSettingsHost {
  private readonly version: number;
  private readonly defaults: Record<string, unknown>;
  private stored: StoredSettings | null = null;
  private loaded = false;

  constructor(private readonly manifest: ExtensionManifest, private readonly store: SettingsStore) {
    this.version = manifest.settings?.version ?? 1;
    this.defaults = structuredClone(manifest.settings?.defaults ?? {});
  }

  /** Loads the settings and migrates them to this release's version. Run before the release activates. */
  async prepare(): Promise<void> {
    const stored = await this.store.load(this.manifest.id);
    this.loaded = true;
    if (!stored || stored.version >= this.version) {
      this.stored = stored;
      return;
    }
    const migrated = encodeSettings(migrateSettings(this.manifest, stored.version, stored.value));
    try {
      const revision = await this.store.save(this.manifest.id, this.version, migrated, stored.revision);
      this.stored = { version: this.version, value: migrated, revision };
    } catch (error) {
      if (!(error instanceof SettingsConflictError)) throw error;
      // Another device migrated or changed them first; take what is stored now.
      this.stored = await this.store.load(this.manifest.id);
    }
  }

  /** The settings the extension sees: the defaults, overlaid with what is stored. */
  current(): Record<string, unknown> {
    return { ...structuredClone(this.defaults), ...structuredClone(this.stored?.value ?? {}) };
  }

  services(): ServiceImplementations {
    return {
      'settings.get': async () => {
        if (!this.loaded) await this.prepare();
        return this.current();
      },
      'settings.set': async (input) => {
        if (!this.loaded) await this.prepare();
        const value = encodeSettings((input as { value?: unknown } | null)?.value);
        if (this.stored && this.stored.version > this.version)
          throw new ExtensionError('extension.unsupported', 'These settings were saved by a newer version of the extension and cannot be changed by this one.');
        try {
          const revision = await this.store.save(this.manifest.id, this.version, value, this.stored?.revision ?? null);
          this.stored = { version: this.version, value, revision };
          return this.current();
        } catch (error) {
          if (!(error instanceof SettingsConflictError)) throw error;
          this.stored = await this.store.load(this.manifest.id);
          throw new ExtensionError('revision.stale', 'The settings changed on another device; read them again and retry.');
        }
      },
    };
  }
}

/** Settings kept in memory, for tests and for runs without an account. */
export function memorySettingsStore(): SettingsStore {
  const rows = new Map<string, StoredSettings>();
  return {
    load: async (id) => structuredClone(rows.get(id) ?? null),
    async save(id, version, value, expectedRevision) {
      const current = rows.get(id);
      if ((current?.revision ?? null) !== expectedRevision) throw new SettingsConflictError();
      const revision = (current?.revision ?? 0) + 1;
      rows.set(id, { version, value: structuredClone(value), revision });
      return revision;
    },
    remove: async (id) => rows.delete(id),
  };
}

/**
 * Settings kept on this device in `storage` (for example `localStorage`), under `scope` (the account), for
 * side-loaded developer extensions, which are never synced.
 */
export function localSettingsStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, scope: string): SettingsStore {
  const key = (id: string) => `pushform:extension-settings:${scope}:${id}`;
  const read = (id: string): StoredSettings | null => {
    try {
      const parsed = JSON.parse(storage.getItem(key(id)) ?? 'null') as StoredSettings | null;
      return parsed && typeof parsed.version === 'number' && typeof parsed.revision === 'number' && isPlainObject(parsed.value) ? parsed : null;
    } catch {
      return null;
    }
  };
  return {
    load: async (id) => read(id),
    async save(id, version, value, expectedRevision) {
      const current = read(id);
      if ((current?.revision ?? null) !== expectedRevision) throw new SettingsConflictError();
      const revision = (current?.revision ?? 0) + 1;
      storage.setItem(key(id), JSON.stringify({ version, value, revision }));
      return revision;
    },
    async remove(id) {
      const existed = read(id) !== null;
      storage.removeItem(key(id));
      return existed;
    },
  };
}

/** A settings store over the account's cloud settings client (its errors mapped to this module's). */
export function cloudSettingsStore(cloud: {
  load(id: string): Promise<StoredSettings | null>;
  save(id: string, version: number, value: Record<string, unknown>, expectedRevision: number | null): Promise<number>;
  remove(id: string): Promise<boolean>;
}): SettingsStore {
  return {
    load: (id) => cloud.load(id),
    save: (id, version, value, expectedRevision) => cloud.save(id, version, value, expectedRevision).catch((error: unknown) => {
      throw error instanceof Error && error.name === 'CloudSettingsConflictError' ? new SettingsConflictError() : error;
    }),
    remove: (id) => cloud.remove(id),
  };
}
