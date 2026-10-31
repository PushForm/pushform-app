// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { zipSync } from 'fflate';
import {
  MANIFEST_FILE, SIGNATURE_FILE, buildManifest, readPackageArchive, validatePackage, type ExtensionManifestInput, type ValidatedPackage,
} from '@pushform/extension-protocol';

/**
 * Packaging. A build directory holds `manifest.json` (without the `files` list) and the built files the package
 * ships: the entry module and anything it imports, WebAssembly modules, icons and locale files. `packDirectory`
 * lists every file with its SHA-256 in the manifest, checks the result with the same validator PushForm runs at
 * install and load, and returns a zip. The zip is deterministic: the same files always give the same bytes.
 */

const SKIP = new Set(['node_modules', '.git', '.DS_Store']);
/** A fixed timestamp for every entry, so packing is reproducible. */
const ZIP_TIME = new Date('2020-01-01T00:00:00Z');

async function listFiles(dir: string, root: string, found: Map<string, Uint8Array>, exclude: ReadonlySet<string>): Promise<void> {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (exclude.has(resolve(path))) continue;
    if (entry.isDirectory()) await listFiles(path, root, found, exclude);
    else if (entry.isFile()) found.set(relative(root, path).split('\\').join('/'), new Uint8Array(await readFile(path)));
  }
}

export interface PackedExtension extends ValidatedPackage {
  readonly archive: Uint8Array;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/** Packs package files whose `manifest.json` lacks the hash list. Throws the validator's error on any problem. */
export async function packFiles(source: ReadonlyMap<string, Uint8Array>): Promise<PackedExtension> {
  const manifestBytes = source.get(MANIFEST_FILE);
  if (!manifestBytes) throw new Error('The build directory has no manifest.json.');
  // A hash list left from an earlier pack is replaced by one for the files packed now.
  const { files: _stale, ...manifest } = JSON.parse(new TextDecoder().decode(manifestBytes)) as ExtensionManifestInput;
  const files = new Map([...source].filter(([path]) => path !== MANIFEST_FILE && path !== SIGNATURE_FILE));
  files.set(MANIFEST_FILE, await buildManifest(manifest, files));
  const validated = await validatePackage(files);
  const entries = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, [bytes, { mtime: ZIP_TIME }] as const]));
  return { ...validated, files, archive: zipSync(entries as Parameters<typeof zipSync>[0], { level: 9 }) };
}

/** Packs a build directory; `exclude` names paths to leave out, such as the archive being written there. */
export async function packDirectory(dir: string, exclude: readonly string[] = []): Promise<PackedExtension> {
  const files = new Map<string, Uint8Array>();
  await listFiles(dir, dir, files, new Set(exclude.map((path) => resolve(path))));
  return packFiles(files);
}

/** Validates a package archive as PushForm does at install. */
export async function validateArchive(archive: Uint8Array): Promise<ValidatedPackage> {
  return validatePackage(readPackageArchive(archive));
}
