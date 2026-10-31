// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { unzipSync } from 'fflate';
import {
  EXTENSION_API_VERSION, MANIFEST_LIMITS, extensionManifestSchema, isPackagePath, satisfiesRange,
  type ExtensionManifest, type ExtensionManifestInput,
} from './manifest.ts';
import { computeModuleProblems } from './wasm.ts';

/**
 * Extension packages. A package is a zip archive holding `manifest.json`, the ES-module entry point and any other
 * JavaScript it imports, optional WASM modules, assets and locale files. There is no installer and nothing runs at
 * install time. The manifest lists the SHA-256 of every other file, so the manifest alone identifies the content.
 * An official package also holds `signature.json`, a PushForm signature over the exact bytes of `manifest.json`;
 * a side-loaded developer package has none. The same validation runs at install and again at every load.
 */

export const MANIFEST_FILE = 'manifest.json';
export const SIGNATURE_FILE = 'signature.json';

export const PACKAGE_LIMITS = {
  archiveBytes: 64 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  files: MANIFEST_LIMITS.files + 2,
} as const;

/**
 * File types a package may contain, by extension. Anything else, including native binaries, installers, shell
 * scripts, HTML and CSS, is refused: extensions draw their UI through host components, never markup.
 */
export const PACKAGE_FILE_TYPES = new Set(['js', 'mjs', 'json', 'wasm', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
  'txt', 'md', 'woff2']);
/** Extensionless files allowed at any depth, such as the license text. */
const PLAIN_TEXT_NAMES = new Set(['LICENSE', 'COPYING', 'NOTICE', 'README', 'AUTHORS']);

/** Why a package was refused. Each reason names one check, so the user and the publisher see what to fix. */
export type PackageProblem =
  | 'archive.invalid' | 'archive.duplicate' | 'path.invalid' | 'path.case-collision' | 'file.type' | 'file.native'
  | 'manifest.missing' | 'manifest.json' | 'manifest.schema' | 'api.unsupported' | 'file.undeclared' | 'file.missing'
  | 'file.hash' | 'main.missing' | 'main.not-module' | 'wasm.missing' | 'wasm.invalid' | 'wasm.abi' | 'icon.missing'
  | 'locale.missing' | 'limit.exceeded' | 'signature.invalid';

/** A structured failure: a stable `code`, a readable message, and the specific problem and file. */
export class ExtensionPackageError extends Error {
  readonly code: 'validation.failed' | 'limit.exceeded' | 'extension.unsupported';
  readonly details: { problem: PackageProblem; path?: string; issues?: readonly string[] };
  constructor(problem: PackageProblem, message: string, details: { path?: string; issues?: readonly string[] } = {}) {
    super(message);
    this.name = 'ExtensionPackageError';
    this.code = problem === 'limit.exceeded' ? 'limit.exceeded' : problem === 'api.unsupported' ? 'extension.unsupported'
      : 'validation.failed';
    this.details = { problem, ...details };
  }
}

/** Package contents by path. */
export type PackageFiles = ReadonlyMap<string, Uint8Array>;

/**
 * Reads a zip archive into package files. Entry sizes, counts and paths are checked from the archive directory
 * before anything is inflated, so an oversized or hostile archive is refused without decompressing it. Directory
 * entries are skipped; duplicate names are refused because they would let two readers see different content.
 */
export function readPackageArchive(archive: Uint8Array): Map<string, Uint8Array> {
  if (archive.byteLength > PACKAGE_LIMITS.archiveBytes)
    throw new ExtensionPackageError('limit.exceeded', `The package is larger than ${mib(PACKAGE_LIMITS.archiveBytes)}.`);
  const seen = new Set<string>();
  const declared = new Map<string, number>();
  let total = 0;
  let refused: ExtensionPackageError | null = null;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive, {
      filter(file) {
        if (refused) return false;
        if (seen.has(file.name)) refused = new ExtensionPackageError('archive.duplicate', `"${file.name}" appears twice in the archive.`, { path: file.name });
        seen.add(file.name);
        if (file.name.endsWith('/')) return false;
        if (!isPackagePath(file.name)) refused = new ExtensionPackageError('path.invalid', `"${file.name}" is not a path inside the package.`, { path: file.name });
        total += file.originalSize;
        if (seen.size > PACKAGE_LIMITS.files) refused = new ExtensionPackageError('limit.exceeded', `The package has more than ${PACKAGE_LIMITS.files} files.`);
        else if (file.originalSize > PACKAGE_LIMITS.fileBytes) refused = new ExtensionPackageError('limit.exceeded', `"${file.name}" is larger than ${mib(PACKAGE_LIMITS.fileBytes)}.`, { path: file.name });
        else if (total > PACKAGE_LIMITS.totalBytes) refused = new ExtensionPackageError('limit.exceeded', `The package expands to more than ${mib(PACKAGE_LIMITS.totalBytes)}.`);
        declared.set(file.name, file.originalSize);
        return refused === null;
      },
    });
  } catch (error) {
    throw refused ?? new ExtensionPackageError('archive.invalid', `The package is not a readable zip archive (${(error as Error).message}).`);
  }
  if (refused) throw refused;
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(entries)) {
    if (bytes.byteLength !== declared.get(name))
      throw new ExtensionPackageError('archive.invalid', `"${name}" does not match its size in the archive directory.`, { path: name });
    files.set(name, bytes);
  }
  return files;
}

/** The outcome of a successful validation. */
export interface ValidatedPackage {
  readonly manifest: ExtensionManifest;
  /** `official` only when a signature is present and the verifier accepted it; otherwise `unsigned`. */
  readonly integrity: 'official' | 'unsigned';
  /** SHA-256 of `manifest.json`: the package's content address, since the manifest lists every other file's hash. */
  readonly contentHash: string;
}

export interface ValidatePackageOptions {
  /**
   * Checks a signature over the exact `manifest.json` bytes. Without a verifier, a package that carries a
   * signature is refused, because its claim to be official cannot be confirmed.
   */
  readonly verifySignature?: (manifestBytes: Uint8Array, signature: Uint8Array) => Promise<boolean>;
  /** The host API version to check `apiVersion` against; defaults to this host's. */
  readonly apiVersion?: string;
}

/** Validates package files completely, or throws the first problem found. Nothing is partially accepted. */
export async function validatePackage(files: PackageFiles, options: ValidatePackageOptions = {}): Promise<ValidatedPackage> {
  checkPaths(files);
  const manifestBytes = files.get(MANIFEST_FILE);
  if (!manifestBytes) throw new ExtensionPackageError('manifest.missing', 'The package has no manifest.json at its root.');
  if (manifestBytes.byteLength > MANIFEST_LIMITS.bytes)
    throw new ExtensionPackageError('limit.exceeded', `manifest.json is larger than ${MANIFEST_LIMITS.bytes / 1024} KiB.`, { path: MANIFEST_FILE });
  const manifest = parseManifest(manifestBytes);
  const apiVersion = options.apiVersion ?? EXTENSION_API_VERSION;
  if (!satisfiesRange(apiVersion, manifest.apiVersion))
    throw new ExtensionPackageError('api.unsupported', `The extension needs extension API ${manifest.apiVersion}; this version of PushForm provides ${apiVersion}.`);

  for (const path of files.keys()) {
    if (path === MANIFEST_FILE || path === SIGNATURE_FILE) continue;
    if (!(path in manifest.files)) throw new ExtensionPackageError('file.undeclared', `"${path}" is not listed in the manifest.`, { path });
  }
  for (const [path, expected] of Object.entries(manifest.files)) {
    const bytes = files.get(path);
    if (!bytes) throw new ExtensionPackageError('file.missing', `"${path}" is listed in the manifest but missing from the package.`, { path });
    if (await sha256Hex(bytes) !== expected)
      throw new ExtensionPackageError('file.hash', `"${path}" does not match its hash in the manifest.`, { path });
  }

  const main = files.get(manifest.main);
  if (!main) throw new ExtensionPackageError('main.missing', `The entry point "${manifest.main}" is missing.`, { path: manifest.main });
  if (!exportsActivate(main))
    throw new ExtensionPackageError('main.not-module', `The entry point "${manifest.main}" must be an ES module that exports activate.`, { path: manifest.main });
  for (const module of manifest.wasm) {
    const bytes = files.get(module.file);
    if (!bytes) throw new ExtensionPackageError('wasm.missing', `The WASM module "${module.name}" has no file "${module.file}".`, { path: module.file });
    if (!isWasm(bytes)) throw new ExtensionPackageError('wasm.invalid', `"${module.file}" is not a WebAssembly module.`, { path: module.file });
    const abi = computeModuleProblems(bytes, module.maxMemoryPages);
    if (abi.length) throw new ExtensionPackageError('wasm.abi', `The WASM module "${module.name}" does not follow the compute interface: ${abi[0]}.`, { path: module.file, issues: abi });
  }
  for (const path of files.keys())
    if (path.endsWith('.wasm') && !manifest.wasm.some((m) => m.file === path))
      throw new ExtensionPackageError('wasm.invalid', `"${path}" is not declared as a WASM module.`, { path });
  if (manifest.icon && !files.has(manifest.icon))
    throw new ExtensionPackageError('icon.missing', `The icon "${manifest.icon}" is missing.`, { path: manifest.icon });
  for (const [locale, path] of Object.entries(manifest.locales))
    if (!files.has(path)) throw new ExtensionPackageError('locale.missing', `The ${locale} locale file "${path}" is missing.`, { path });

  const signature = files.get(SIGNATURE_FILE);
  let integrity: ValidatedPackage['integrity'] = 'unsigned';
  if (signature) {
    const valid = options.verifySignature ? await options.verifySignature(manifestBytes, signature).catch(() => false) : false;
    if (!valid) throw new ExtensionPackageError('signature.invalid', 'The package is signed, but its signature could not be verified.', { path: SIGNATURE_FILE });
    integrity = 'official';
  }
  return { manifest, integrity, contentHash: await sha256Hex(manifestBytes) };
}

/**
 * Builds the `manifest.json` bytes for a set of package files: the given manifest fields plus the hash of every file.
 * Packaging tools and tests use it; the result validates with `validatePackage` when the files are consistent.
 */
export async function buildManifest(manifest: Omit<ExtensionManifestInput, 'files'>, files: PackageFiles): Promise<Uint8Array> {
  const hashes: Record<string, string> = {};
  for (const path of [...files.keys()].sort())
    if (path !== MANIFEST_FILE && path !== SIGNATURE_FILE) hashes[path] = await sha256Hex(files.get(path)!);
  return new TextEncoder().encode(`${JSON.stringify({ ...manifest, files: hashes }, null, 2)}\n`);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseManifest(bytes: Uint8Array): ExtensionManifest {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ExtensionPackageError('manifest.json', 'manifest.json is not valid UTF-8 JSON.', { path: MANIFEST_FILE });
  }
  const parsed = extensionManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ExtensionPackageError('manifest.schema', `manifest.json is invalid: ${issues[0]}`, { path: MANIFEST_FILE, issues });
  }
  return parsed.data;
}

function checkPaths(files: PackageFiles): void {
  if (files.size > PACKAGE_LIMITS.files) throw new ExtensionPackageError('limit.exceeded', `The package has more than ${PACKAGE_LIMITS.files} files.`);
  const folded = new Map<string, string>();
  let total = 0;
  for (const [path, bytes] of files) {
    if (!isPackagePath(path)) throw new ExtensionPackageError('path.invalid', `"${path}" is not a path inside the package.`, { path });
    const lower = path.toLowerCase();
    const other = folded.get(lower);
    if (other !== undefined) throw new ExtensionPackageError('path.case-collision', `"${path}" and "${other}" differ only by case.`, { path });
    folded.set(lower, path);
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    const type = dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
    if (type === null ? !PLAIN_TEXT_NAMES.has(name) : !PACKAGE_FILE_TYPES.has(type))
      throw new ExtensionPackageError('file.type', `"${path}" is not a file type extensions may contain.`, { path });
    if (isNativeBinary(bytes)) throw new ExtensionPackageError('file.native', `"${path}" is a native executable.`, { path });
    total += bytes.byteLength;
    if (bytes.byteLength > PACKAGE_LIMITS.fileBytes || total > PACKAGE_LIMITS.totalBytes)
      throw new ExtensionPackageError('limit.exceeded', 'The package is too large.', { path });
  }
}

const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean =>
  bytes.byteLength >= magic.length && magic.every((b, i) => bytes[i] === b);

function isWasm(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
}

/** ELF, Mach-O (both byte orders, 32 and 64 bit, and universal) and PE/COFF executables. */
function isNativeBinary(bytes: Uint8Array): boolean {
  return [[0x7f, 0x45, 0x4c, 0x46], [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], [0x4d, 0x5a]].some((magic) => startsWith(bytes, magic));
}

/**
 * A static check that the entry point is UTF-8 ES-module source exporting `activate`, as a function declaration,
 * a `const`/`let`, or an export list (`export { start as activate }`, the form bundlers emit). Whether the module
 * really evaluates is only known when the isolated runtime imports it.
 */
function exportsActivate(bytes: Uint8Array): boolean {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return /\bexport\s+(?:async\s+)?function\s*\*?\s*activate\b/.test(source)
    || /\bexport\s+(?:const|let|var)\s+activate\b/.test(source)
    || /\bexport\s*\{[^}]*\bas\s+activate\b[^}]*\}/.test(source)
    || /\bexport\s*\{(?:[^}]*,)?\s*activate\s*(?:,[^}]*)?\}/.test(source);
}

const mib = (bytes: number): string => `${bytes / (1024 * 1024)} MiB`;
