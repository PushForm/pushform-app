// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';

/**
 * Extension manifest, the `manifest.json` at the root of every extension package. It is the only description of an
 * extension the host trusts: contributions, permissions, network destinations, WASM modules, settings and locales are
 * all declared here, and every other file of the package is listed with its SHA-256 hash. Unknown fields are rejected
 * rather than ignored, so a typo never silently drops a declaration.
 */

/** The extension API version this host serves. A manifest's `apiVersion` range must include it. */
export const EXTENSION_API_VERSION = '0.1.0';

/** Bounds on a manifest, applied before any other processing. */
export const MANIFEST_LIMITS = {
  bytes: 256 * 1024,
  contributions: 100,
  destinations: 20,
  wasmModules: 16,
  locales: 50,
  files: 1000,
  pathChars: 200,
  textChars: 500,
  /** 64 KiB pages: 4096 pages is 256 MiB, the most a compute module may declare. */
  wasmMaxPages: 4096,
  wasmMaxTimeoutMs: 10 * 60 * 1000,
} as const;

/** Contribution targets an extension can declare. */
export const EXTENSION_TARGETS = ['model.command', 'model.selection.action', 'model.inspector.block', 'model.panel',
  'model.tool', 'model.overlay', 'model.importer', 'model.exporter', 'app.settings.block'] as const;
export type ExtensionTarget = (typeof EXTENSION_TARGETS)[number];

/**
 * Permissions an extension can request. Each one is granted separately: model write does not imply file, clipboard
 * or network access, and `model.egress` (sending model content to a declared destination) is separate from `network`.
 */
export const EXTENSION_PERMISSIONS = ['model.read', 'model.write', 'selection.read', 'selection.write',
  'tool.interaction', 'viewport.presentation', 'file.read', 'file.export', 'settings', 'clipboard.write', 'network',
  'model.egress'] as const;
export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number];

/** What starts an extension's code. Code never runs at install or load; only one of these does. */
export const ACTIVATION_EVENTS = ['onCommand', 'onSelectionAction', 'onInspectorShow', 'onPanelOpen', 'onToolActivate',
  'onOverlayShow', 'onImport', 'onExport', 'onSettingsOpen'] as const;
export type ActivationEvent = (typeof ACTIVATION_EVENTS)[number];

/** The activation event each target uses; a contribution may omit `activation` or must name this one. */
export const TARGET_ACTIVATION: Readonly<Record<ExtensionTarget, ActivationEvent>> = {
  'model.command': 'onCommand',
  'model.selection.action': 'onSelectionAction',
  'model.inspector.block': 'onInspectorShow',
  'model.panel': 'onPanelOpen',
  'model.tool': 'onToolActivate',
  'model.overlay': 'onOverlayShow',
  'model.importer': 'onImport',
  'model.exporter': 'onExport',
  'app.settings.block': 'onSettingsOpen',
};

export const EXTENSION_EDITORS = ['modeling', 'layout'] as const;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
/** Reverse-DNS id with at least two labels, lowercase, for example `io.pushform.cut-list`. */
const EXTENSION_ID = /^[a-z][a-z0-9-]{0,62}(\.[a-z][a-z0-9-]{0,62})+$/;
/** A contribution id is the extension id followed by one or more further labels. */
const CONTRIBUTION_SUFFIX = /^(\.[a-z][a-z0-9-]{0,62})+$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * A path inside the package: relative, `/`-separated, no empty, `.` or `..` segments, no backslashes, colons or
 * control characters. Paths that only differ by case are rejected separately when the whole file list is known.
 */
export function isPackagePath(path: string): boolean {
  if (path.length === 0 || path.length > MANIFEST_LIMITS.pathChars) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\\:\u0000-\u001f\u007f]/.test(path) || path.startsWith('/')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const text = z.string().trim().min(1).max(MANIFEST_LIMITS.textChars);
const packagePath = z.string().refine(isPackagePath, { message: 'must be a relative path inside the package' });
const semver = z.string().regex(SEMVER, 'must be a semantic version such as 1.2.3');
const versionRange = z.string().max(100).refine((range) => parseRange(range) !== null,
  { message: 'must be a version range such as ^0.1.0 or >=1.0.0 <2.0.0' });

const contribution = z.strictObject({
  target: z.enum(EXTENSION_TARGETS),
  id: z.string().max(200),
  name: text,
  activation: z.enum(ACTIVATION_EVENTS).optional(),
  /** Permissions the contribution needs; each must also be requested by the manifest. */
  capabilities: z.array(z.enum(EXTENSION_PERMISSIONS)).max(EXTENSION_PERMISSIONS.length).optional(),
});

const destination = z.strictObject({
  /** An HTTPS origin, optionally with a path prefix, such as `https://api.example.com/v1`. */
  url: z.string().max(300).refine(isHttpsDestination, { message: 'must be an https URL with no credentials, query or fragment' }),
  /** Shown to the user next to the destination in the install dialog. */
  purpose: text,
  /** Whether requests to this destination can carry model content. Needs the `model.egress` permission. */
  sendsModelData: z.boolean(),
});

const wasmModule = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  file: packagePath.refine((path) => path.endsWith('.wasm'), { message: 'must name a .wasm file' }),
  maxMemoryPages: z.number().int().min(1).max(MANIFEST_LIMITS.wasmMaxPages),
  timeoutMs: z.number().int().min(1).max(MANIFEST_LIMITS.wasmMaxTimeoutMs),
  /** JSON Schemas of the module's input and output messages, checked by the host on every call. */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

const settings = z.strictObject({
  /** Increases when the stored shape changes; the host runs the declared migration before activation. */
  version: z.number().int().min(1),
  schema: z.record(z.string(), z.unknown()),
  defaults: z.record(z.string(), z.unknown()),
});

export const extensionManifestSchema = z.strictObject({
  id: z.string().max(200).regex(EXTENSION_ID, 'must be a lowercase reverse-DNS id such as com.example.stairs'),
  name: text,
  publisher: text,
  description: z.string().max(2000).optional(),
  icon: packagePath.optional(),
  version: semver,
  apiVersion: versionRange,
  /** The single JavaScript entry point: an ES module exporting `activate(context)` and optionally `deactivate()`. */
  main: packagePath.refine((path) => /\.m?js$/.test(path), { message: 'must name a .js or .mjs file' }).default('main.js'),
  editors: z.array(z.enum(EXTENSION_EDITORS)).min(1).max(EXTENSION_EDITORS.length),
  contributions: z.array(contribution).min(1).max(MANIFEST_LIMITS.contributions),
  permissions: z.array(z.enum(EXTENSION_PERMISSIONS)).max(EXTENSION_PERMISSIONS.length),
  destinations: z.array(destination).max(MANIFEST_LIMITS.destinations).default([]),
  wasm: z.array(wasmModule).max(MANIFEST_LIMITS.wasmModules).default([]),
  settings: settings.optional(),
  defaultLocale: z.string().regex(LOCALE),
  /** Locale files by language tag, for example `{ "fr": "locales/fr.json" }`. */
  locales: z.record(z.string().regex(LOCALE), packagePath).default({}),
  license: z.string().trim().min(1).max(200).describe('SPDX license expression'),
  /** Where the corresponding source is available; required for copyleft licenses. */
  sourceUrl: z.string().max(300).refine(isHttpsUrl, { message: 'must be an https URL' }).optional(),
  /** SHA-256 (lowercase hex) of every file in the package except `manifest.json` and the signature. */
  files: z.record(packagePath, z.string().regex(SHA256, 'must be a lowercase hex SHA-256 digest')),
}).superRefine((manifest, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const permissions = new Set(manifest.permissions);
  if (permissions.size !== manifest.permissions.length) issue(['permissions'], 'lists a permission more than once');
  const ids = new Set<string>();
  manifest.contributions.forEach((c, i) => {
    const suffix = c.id.startsWith(manifest.id) ? c.id.slice(manifest.id.length) : null;
    if (suffix === null || !CONTRIBUTION_SUFFIX.test(suffix)) issue(['contributions', i, 'id'], `must start with "${manifest.id}."`);
    if (ids.has(c.id)) issue(['contributions', i, 'id'], 'is declared twice');
    ids.add(c.id);
    if (c.activation && c.activation !== TARGET_ACTIVATION[c.target])
      issue(['contributions', i, 'activation'], `must be ${TARGET_ACTIVATION[c.target]} for ${c.target}`);
    c.capabilities?.forEach((p, j) => {
      if (!permissions.has(p)) issue(['contributions', i, 'capabilities', j], `${p} is not in the manifest's permissions`);
    });
  });
  if (manifest.destinations.length > 0 && !permissions.has('network'))
    issue(['permissions'], 'must include network when destinations are declared');
  if (manifest.destinations.length === 0 && permissions.has('network'))
    issue(['permissions'], 'requests network but declares no destinations');
  const egress = manifest.destinations.some((d) => d.sendsModelData);
  if (egress !== permissions.has('model.egress'))
    issue(['permissions'], egress ? 'must include model.egress when a destination sends model data'
      : 'requests model.egress but no destination sends model data');
  const names = new Set<string>();
  manifest.wasm.forEach((m, i) => {
    if (names.has(m.name)) issue(['wasm', i, 'name'], 'is declared twice');
    names.add(m.name);
  });
  if (!(manifest.defaultLocale in manifest.locales) && Object.keys(manifest.locales).length > 0)
    issue(['locales'], `must include the default locale ${manifest.defaultLocale}`);
  if (Object.keys(manifest.locales).length > MANIFEST_LIMITS.locales) issue(['locales'], 'lists too many locales');
  if (Object.keys(manifest.files).length > MANIFEST_LIMITS.files) issue(['files'], 'lists too many files');
});

export type ExtensionManifest = z.output<typeof extensionManifestSchema>;
export type ExtensionManifestInput = z.input<typeof extensionManifestSchema>;

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function isHttpsDestination(value: string): boolean {
  if (!isHttpsUrl(value)) return false;
  const url = new URL(value);
  return url.search === '' && url.hash === '' && !value.includes('?') && !value.includes('#');
}

// Semantic versions and ranges. Only the forms extension manifests need: exact versions, comparators
// (`>=`, `>`, `<=`, `<`, `=`), caret and tilde ranges, space-separated comparators that must all hold, and `||`
// alternatives. Prerelease versions satisfy a range only through a comparator naming the same major.minor.patch.

type Version = readonly [number, number, number, string | null];
type Comparator = { op: '>=' | '>' | '<=' | '<' | '='; version: Version };

export function parseVersion(value: string): Version | null {
  const match = SEMVER.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null] : null;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  if (a[3] === b[3]) return 0;
  if (a[3] === null) return 1;
  if (b[3] === null) return -1;
  const left = a[3].split('.');
  const right = b[3].split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parseComparators(part: string): Comparator[] | null {
  const comparators: Comparator[] = [];
  for (const token of part.trim().split(/\s+/)) {
    const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
    const version = match && parseVersion(match[2]!);
    if (!match || !version) return null;
    const [major, minor, patch] = version;
    switch (match[1]) {
      case '^': {
        const upper: Version = major > 0 ? [major + 1, 0, 0, null] : minor > 0 ? [0, minor + 1, 0, null] : [0, 0, patch + 1, null];
        comparators.push({ op: '>=', version }, { op: '<', version: upper });
        break;
      }
      case '~':
        comparators.push({ op: '>=', version }, { op: '<', version: [major, minor + 1, 0, null] });
        break;
      default:
        comparators.push({ op: (match[1] ?? '=') as Comparator['op'], version });
    }
  }
  return comparators;
}

function parseRange(range: string): Comparator[][] | null {
  if (range.trim() === '') return null;
  const alternatives = range.split('||').map(parseComparators);
  return alternatives.every((a): a is Comparator[] => a !== null) ? alternatives : null;
}

/** Whether `version` lies in `range`. An unparsable version or range satisfies nothing. */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  const alternatives = parseRange(range);
  if (!v || !alternatives) return false;
  return alternatives.some((comparators) => {
    if (v[3] !== null && !comparators.some((c) => c.version[3] !== null
      && c.version[0] === v[0] && c.version[1] === v[1] && c.version[2] === v[2])) return false;
    return comparators.every(({ op, version: bound }) => {
      const order = compareVersions(v, bound);
      return op === '>=' ? order >= 0 : op === '>' ? order > 0 : op === '<=' ? order <= 0 : op === '<' ? order < 0 : order === 0;
    });
  });
}
