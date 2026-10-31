// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extensionManifestSchema, satisfiesRange, type ExtensionManifestInput } from './manifest.ts';
import {
  ExtensionPackageError, MANIFEST_FILE, SIGNATURE_FILE, buildManifest, readPackageArchive, sha256Hex, validatePackage,
  type PackageProblem,
} from './package.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
/** The smallest module following the compute interface: it imports pf.memory and exports the three ABI functions. */
export const COMPUTE_MODULE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 16, 3, 96, 0, 1, 127, 96, 1, 127, 1, 127, 96, 2, 127, 127, 1, 127,
  2, 14, 1, 2, 112, 102, 6, 109, 101, 109, 111, 114, 121, 2, 0, 1, 3, 4, 3, 0, 1, 2, 7, 38, 3, 14, 112, 102, 95, 97, 98, 105, 95, 118, 101,
  114, 115, 105, 111, 110, 0, 0, 8, 112, 102, 95, 97, 108, 108, 111, 99, 0, 1, 6, 112, 102, 95, 114, 117, 110, 0, 2, 10, 17, 3, 4, 0, 65,
  1, 11, 5, 0, 65, 128, 8, 11, 4, 0, 65, 0, 11]);
const WASM = COMPUTE_MODULE;
const BARE_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const baseManifest = {
  id: 'com.example.stairs',
  name: 'Stairs',
  publisher: 'Example',
  version: '1.2.0',
  apiVersion: '^0.1.0',
  main: 'main.js',
  editors: ['modeling'],
  contributions: [
    { target: 'model.command', id: 'com.example.stairs.generate', name: 'Generate stairs', activation: 'onCommand' },
    { target: 'model.panel', id: 'com.example.stairs.panel', name: 'Stairs' },
  ],
  permissions: ['model.read', 'model.write'],
  defaultLocale: 'en',
  license: 'MIT',
} satisfies Omit<ExtensionManifestInput, 'files'>;

type Overrides = Partial<Omit<ExtensionManifestInput, 'files'>>;

/** Package files whose manifest lists the given files' hashes; `edit` may then tamper with the result. */
async function makePackage(overrides: Overrides = {}, extra: Record<string, Uint8Array> = {}): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>([
    ['main.js', encode('import { start } from "./lib/start.js";\nexport async function activate(context) { start(context); }\n')],
    ['lib/start.js', encode('export function start() {}\n')],
    ...Object.entries(extra),
  ]);
  files.set(MANIFEST_FILE, await buildManifest({ ...baseManifest, ...overrides }, files));
  return files;
}

async function problemOf(run: Promise<unknown>): Promise<{ problem: PackageProblem; code: string; path?: string | undefined }> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ExtensionPackageError) return { problem: error.details.problem, code: error.code, path: error.details.path };
    throw error;
  }
  throw new Error('expected the package to be refused');
}

describe('validatePackage', () => {
  it('accepts a consistent unsigned package and reports its content hash', async () => {
    const files = await makePackage();
    const result = await validatePackage(files);
    expect(result.integrity).toBe('unsigned');
    expect(result.manifest.id).toBe('com.example.stairs');
    expect(result.manifest.destinations).toEqual([]);
    expect(result.contentHash).toBe(await sha256Hex(files.get(MANIFEST_FILE)!));
  });

  it('refuses a missing manifest, invalid JSON and unknown fields', async () => {
    const files = await makePackage();
    files.delete(MANIFEST_FILE);
    expect((await problemOf(validatePackage(files))).problem).toBe('manifest.missing');
    files.set(MANIFEST_FILE, encode('{ not json'));
    expect((await problemOf(validatePackage(files))).problem).toBe('manifest.json');
    const unknown = await makePackage({ homepage: 'https://example.com' } as Overrides);
    expect(await problemOf(validatePackage(unknown))).toMatchObject({ problem: 'manifest.schema', code: 'validation.failed' });
  });

  it('refuses unknown targets and contributions that carry their own entry point', async () => {
    const target = await makePackage({ contributions: [{ target: 'model.toolbar' as 'model.command', id: 'com.example.stairs.x', name: 'X' }] });
    expect((await problemOf(validatePackage(target))).problem).toBe('manifest.schema');
    const entry = await makePackage({ contributions: [{ ...baseManifest.contributions[0], entry: 'other.js' } as never] });
    expect((await problemOf(validatePackage(entry))).problem).toBe('manifest.schema');
  });

  it('refuses an unsupported apiVersion with extension.unsupported', async () => {
    const files = await makePackage({ apiVersion: '^2.0.0' });
    expect(await problemOf(validatePackage(files))).toMatchObject({ problem: 'api.unsupported', code: 'extension.unsupported' });
  });

  it('refuses undeclared, missing and modified files', async () => {
    const undeclared = await makePackage();
    undeclared.set('extra.js', encode('export {}'));
    expect(await problemOf(validatePackage(undeclared))).toMatchObject({ problem: 'file.undeclared', path: 'extra.js' });
    const missing = await makePackage();
    missing.delete('lib/start.js');
    expect(await problemOf(validatePackage(missing))).toMatchObject({ problem: 'file.missing', path: 'lib/start.js' });
    const modified = await makePackage();
    modified.set('lib/start.js', encode('export function start() { steal(); }\n'));
    expect(await problemOf(validatePackage(modified))).toMatchObject({ problem: 'file.hash', path: 'lib/start.js' });
  });

  it('refuses a main that is missing, outside the package, or not an ES module exporting activate', async () => {
    const missing = await makePackage({ main: 'index.js' });
    expect((await problemOf(validatePackage(missing))).problem).toBe('main.missing');
    const outside = await makePackage({ main: '../main.js' });
    expect((await problemOf(validatePackage(outside))).problem).toBe('manifest.schema');
    const script = await makePackage({}, {});
    script.set('main.js', encode('function activate() {}\nmodule.exports = { activate };\n'));
    script.set(MANIFEST_FILE, await buildManifest(baseManifest, script));
    expect((await problemOf(validatePackage(script))).problem).toBe('main.not-module');
  });

  it('accepts the export-list form bundlers emit', async () => {
    const files = await makePackage();
    files.set('main.js', encode('async function e(){}\nfunction d(){}\nexport { e as activate, d as deactivate };\n'));
    files.set(MANIFEST_FILE, await buildManifest(baseManifest, files));
    await expect(validatePackage(files)).resolves.toMatchObject({ integrity: 'unsigned' });
  });

  it('requires every declared WASM module to exist and every .wasm file to be declared', async () => {
    const wasm = [{ name: 'packer', file: 'wasm/packer.wasm', maxMemoryPages: 1024, timeoutMs: 60000 }];
    await expect(validatePackage(await makePackage({ wasm }, { 'wasm/packer.wasm': WASM }))).resolves.toBeDefined();
    expect(await problemOf(validatePackage(await makePackage({ wasm })))).toMatchObject({ problem: 'wasm.missing' });
    const bare = await makePackage({ wasm }, { 'wasm/packer.wasm': BARE_WASM });
    expect(await problemOf(validatePackage(bare))).toMatchObject({ problem: 'wasm.abi', path: 'wasm/packer.wasm' });
    const tooSmall = await makePackage({ wasm: [{ ...wasm[0]!, maxMemoryPages: 1 }] }, { 'wasm/packer.wasm': WASM });
    await expect(validatePackage(tooSmall)).resolves.toBeDefined();
    const notWasm = await makePackage({ wasm }, { 'wasm/packer.wasm': encode('hello') });
    expect((await problemOf(validatePackage(notWasm))).problem).toBe('wasm.invalid');
    const undeclared = await makePackage({}, { 'wasm/packer.wasm': WASM });
    expect(await problemOf(validatePackage(undeclared))).toMatchObject({ problem: 'wasm.invalid', path: 'wasm/packer.wasm' });
  });

  it('refuses native binaries, disallowed file types and case-colliding paths', async () => {
    const elf = await makePackage({}, { 'lib/helper.js': new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0]) });
    expect(await problemOf(validatePackage(elf))).toMatchObject({ problem: 'file.native', path: 'lib/helper.js' });
    const html = await makePackage({}, { 'panel.html': encode('<script>') });
    expect(await problemOf(validatePackage(html))).toMatchObject({ problem: 'file.type', path: 'panel.html' });
    const exe = await makePackage({}, { 'setup.exe': encode('MZ') });
    expect((await problemOf(validatePackage(exe))).problem).toBe('file.type');
    const cased = await makePackage({}, { 'lib/Start.js': encode('export {}') });
    expect((await problemOf(validatePackage(cased))).problem).toBe('path.case-collision');
    await expect(validatePackage(await makePackage({}, { LICENSE: encode('MIT') }))).resolves.toBeDefined();
  });

  it('requires declared icons and locale files to exist', async () => {
    expect((await problemOf(validatePackage(await makePackage({ icon: 'icon.svg' })))).problem).toBe('icon.missing');
    const locales = { en: 'locales/en.json', fr: 'locales/fr.json' };
    const partial = await makePackage({ locales }, { 'locales/en.json': encode('{}') });
    expect(await problemOf(validatePackage(partial))).toMatchObject({ problem: 'locale.missing', path: 'locales/fr.json' });
  });

  it('is official only with a signature the verifier accepts, over the exact manifest bytes', async () => {
    const files = await makePackage();
    files.set(SIGNATURE_FILE, encode('{"sig":"x"}'));
    expect((await problemOf(validatePackage(files))).problem).toBe('signature.invalid');
    expect((await problemOf(validatePackage(files, { verifySignature: async () => false }))).problem).toBe('signature.invalid');
    expect((await problemOf(validatePackage(files, { verifySignature: async () => { throw new Error('offline'); } }))).problem)
      .toBe('signature.invalid');
    let signed: Uint8Array | null = null;
    const result = await validatePackage(files, { verifySignature: async (manifest) => { signed = manifest; return true; } });
    expect(result.integrity).toBe('official');
    expect(signed).toEqual(files.get(MANIFEST_FILE));
  });
});

describe('manifest rules', () => {
  const parse = (overrides: Overrides) => extensionManifestSchema.safeParse({ ...baseManifest, files: {}, ...overrides });

  it('namespaces contribution ids under the extension id and forbids duplicates', () => {
    expect(parse({ contributions: [{ target: 'model.command', id: 'com.other.generate', name: 'X' }] }).success).toBe(false);
    expect(parse({ contributions: [{ target: 'model.command', id: 'com.example.stairsx', name: 'X' }] }).success).toBe(false);
    const twice = { target: 'model.command' as const, id: 'com.example.stairs.a', name: 'A' };
    expect(parse({ contributions: [twice, twice] }).success).toBe(false);
  });

  it('ties activation events to targets and capabilities to requested permissions', () => {
    expect(parse({ contributions: [{ target: 'model.panel', id: 'com.example.stairs.p', name: 'P', activation: 'onCommand' }] }).success).toBe(false);
    expect(parse({ contributions: [{ target: 'model.panel', id: 'com.example.stairs.p', name: 'P', capabilities: ['file.export'] }] }).success).toBe(false);
  });

  it('requires network for destinations and model.egress exactly when a destination receives model data', () => {
    const destination = { url: 'https://api.example.com/v1', purpose: 'Price lookup', sendsModelData: false };
    expect(parse({ destinations: [destination] }).success).toBe(false);
    expect(parse({ destinations: [destination], permissions: ['model.read', 'network'] }).success).toBe(true);
    expect(parse({ permissions: ['model.read', 'network'] }).success).toBe(false);
    const upload = { ...destination, sendsModelData: true };
    expect(parse({ destinations: [upload], permissions: ['network'] }).success).toBe(false);
    expect(parse({ destinations: [upload], permissions: ['network', 'model.egress'] }).success).toBe(true);
    for (const url of ['http://api.example.com', 'https://u:p@api.example.com', 'https://api.example.com/?q=1'])
      expect(parse({ destinations: [{ ...destination, url }], permissions: ['network'] }).success).toBe(false);
  });

  it('accepts any declared license, so publishers are not limited to copyleft', () => {
    expect(parse({ license: 'LicenseRef-Proprietary' }).success).toBe(true);
    expect(parse({ license: 'GPL-3.0-or-later', sourceUrl: 'https://github.com/example/stairs' }).success).toBe(true);
  });
});

describe('satisfiesRange', () => {
  it.each([
    ['0.1.0', '^0.1.0', true], ['0.1.9', '^0.1.0', true], ['0.2.0', '^0.1.0', false],
    ['1.4.0', '^1.2.0', true], ['2.0.0', '^1.2.0', false], ['1.2.9', '~1.2.0', true], ['1.3.0', '~1.2.0', false],
    ['1.5.0', '>=1.0.0 <2.0.0', true], ['2.0.0', '>=1.0.0 <2.0.0', false], ['3.1.0', '^1.0.0 || ^3.0.0', true],
    ['1.0.0-beta.1', '^1.0.0', false], ['1.0.0-beta.2', '>=1.0.0-beta.1 <2.0.0', true], ['1.0.0', 'nonsense', false],
  ])('%s in %s is %s', (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
});

describe('readPackageArchive', () => {
  it('reads a zip and skips directory entries', async () => {
    const files = await makePackage();
    const archive = zipSync({ ...Object.fromEntries(files), 'lib/': new Uint8Array() });
    const read = readPackageArchive(archive);
    expect([...read.keys()].sort()).toEqual(['lib/start.js', 'main.js', 'manifest.json']);
    await expect(validatePackage(read)).resolves.toMatchObject({ integrity: 'unsigned' });
  });

  it('refuses paths that escape the package and archives that are not zips', async () => {
    const archive = zipSync({ '../evil.js': encode('x') });
    expect(await problemOf(Promise.resolve().then(() => readPackageArchive(archive)))).toMatchObject({ problem: 'path.invalid' });
    expect((await problemOf(Promise.resolve().then(() => readPackageArchive(encode('not a zip'))))).problem).toBe('archive.invalid');
  });

  it('refuses an entry whose declared size is over the limit before inflating it', async () => {
    const big = zipSync({ 'big.txt': new Uint8Array(65 * 1024 * 1024) }, { level: 9 });
    expect(big.byteLength).toBeLessThan(1024 * 1024);
    expect(await problemOf(Promise.resolve().then(() => readPackageArchive(big)))).toMatchObject({ problem: 'limit.exceeded', code: 'limit.exceeded' });
  });
});
