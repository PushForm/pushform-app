// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global console, process */
// Publishes desktop installers to the downloads bucket in Cloudflare R2 (Desktop builds), run by
// the publish job of .github/workflows/desktop.yml. Installers are named PushForm-<label>-<platform><suffix>, where the
// label is the version or `nightly`. Each is uploaded through R2's S3-compatible API with the AWS CLI (preinstalled on
// GitHub's runners), then the channel's index is updated and uploaded last, so the download page (the download page)
// never lists a file that is not there yet. The S3 API, unlike the REST API Wrangler uses, accepts R2 tokens scoped to
// one bucket, so the publishing credentials can write nothing else.
//
//   stable:  desktop/stable/<version>/<file>, index desktop/releases.json (every stable release, newest first)
//   nightly: desktop/nightly/<file> (replaced each night), index desktop/nightly.json (that one release)
//
// Builds signed with the updater key also carry `<file>.sig` signatures and the macOS updater
// archive PushForm-<label>-macos-arm64.app.tar.gz. The archive is uploaded beside the installers but not listed in the
// index; the signatures are not uploaded but written into the channel's updater manifest, desktop/<channel>/latest.json
// (Tauri's static update format), uploaded last. Desktop apps check it for updates.
//
//   node scripts/desktop-release.mjs --channel stable --version 26.44.44 --commit <sha> --dir out
//   Environment: DOWNLOADS_BUCKET, DOWNLOADS_URL, CLOUDFLARE_ACCOUNT_ID (names the S3 endpoint), and the bucket's
//   R2 access key as AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.
//   --dry-run prints the uploads and the index instead of running the AWS CLI.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FORMATS = [
  { suffix: '-setup.exe', format: 'exe', type: 'application/vnd.microsoft.portable-executable' },
  { suffix: '.msi', format: 'msi', type: 'application/x-msi' },
  { suffix: '.dmg', format: 'dmg', type: 'application/x-apple-diskimage' },
  { suffix: '.AppImage', format: 'appimage', type: 'application/vnd.appimage' },
  { suffix: '.deb', format: 'deb', type: 'application/vnd.debian.binary-package' },
  { suffix: '.rpm', format: 'rpm', type: 'application/x-rpm' },
];
const PLATFORMS = ['windows-x64', 'macos-arm64', 'linux-x86_64'];
/** The macOS app as the updater installs it; not a download for people. */
const UPDATER_ARCHIVE = { suffix: '.app.tar.gz', format: 'app', type: 'application/gzip' };
/**
 * Tauri updater targets (`{os}-{arch}-{bundle type}`) per platform and format. The first format of each platform also
 * serves `{os}-{arch}`, which an app checks when it does not know how it was installed.
 */
const UPDATER_TARGETS = {
  'windows-x64': { os: 'windows-x86_64', formats: { exe: 'nsis', msi: 'msi' } },
  'macos-arm64': { os: 'darwin-aarch64', formats: { app: 'app' } },
  'linux-x86_64': { os: 'linux-x86_64', formats: { appimage: 'appimage', deb: 'deb', rpm: 'rpm' } },
};

/** Platform, format and MIME type of an installer named PushForm-<label>-<platform><suffix>; null for anything else. */
export function classify(name, label) {
  for (const { suffix, format, type } of FORMATS) {
    for (const platform of PLATFORMS) {
      if (name === `PushForm-${label}-${platform}${suffix}`) return { platform, format, type };
    }
  }
  return null;
}

/** The macOS updater archive named PushForm-<label>-<platform>.app.tar.gz; null for anything else. */
export function classifyUpdaterArchive(name, label) {
  for (const platform of PLATFORMS) {
    if (name === `PushForm-${label}-${platform}${UPDATER_ARCHIVE.suffix}`) {
      return { platform, format: UPDATER_ARCHIVE.format, type: UPDATER_ARCHIVE.type };
    }
  }
  return null;
}

/** Object key of an installer in the bucket. */
export function objectKey(channel, version, name) {
  return channel === 'stable' ? `desktop/stable/${version}/${name}` : `desktop/nightly/${name}`;
}

/** Object key of a channel's index. */
export function indexKey(channel) {
  return channel === 'stable' ? 'desktop/releases.json' : 'desktop/nightly.json';
}

/** Object key of a channel's updater manifest. */
export function updaterKey(channel) {
  return `desktop/${channel}/latest.json`;
}

/**
 * Tauri's static update manifest for the signed files ({ platform, format, url, signature }). Nightly files are replaced
 * in place under fixed names, so their URLs carry the version: a cached copy of last night's file never meets this
 * night's signature. Null when no file is signed (a build without the updater key).
 */
export function updaterManifest(channel, version, date, signed) {
  const platforms = {};
  for (const { platform, format, url, signature } of signed) {
    const target = UPDATER_TARGETS[platform];
    const kind = target?.formats[format];
    if (!kind) continue;
    const entry = {
      signature,
      url: channel === 'nightly' ? `${url}?v=${encodeURIComponent(version)}` : url,
    };
    platforms[`${target.os}-${kind}`] = entry;
    if (Object.values(target.formats)[0] === kind) platforms[target.os] = entry;
  }
  return Object.keys(platforms).length ? { version, pub_date: date, platforms } : null;
}

/**
 * The channel's index with `release` added. Stable keeps every release newest first, replacing one of the same version
 * (a re-run); nightly holds only the latest.
 */
export function withRelease(index, channel, release, updated) {
  const previous =
    channel === 'stable'
      ? (index?.releases ?? []).filter((r) => r.version !== release.version)
      : [];
  const releases = [release, ...previous].sort((a, b) => compareVersions(b.version, a.version));
  return { channel, updated, releases };
}

/** Numeric comparison of dotted versions such as 26.44.9 and 26.44.10. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const channel = flag('--channel');
  const version = flag('--version');
  const commit = flag('--commit');
  const dir = flag('--dir');
  const dryRun = argv.includes('--dry-run');
  const bucket = process.env.DOWNLOADS_BUCKET;
  const baseUrl = process.env.DOWNLOADS_URL?.replace(/\/$/, '');
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (
    !['stable', 'nightly'].includes(channel) ||
    !version ||
    !commit ||
    !dir ||
    !bucket ||
    !baseUrl ||
    !accountId
  ) {
    console.error(
      'desktop-release: needs --channel stable|nightly, --version, --commit, --dir, DOWNLOADS_BUCKET, DOWNLOADS_URL and CLOUDFLARE_ACCOUNT_ID',
    );
    process.exit(2);
  }

  const s3api = (args) => {
    const full = [
      's3api',
      ...args,
      '--bucket',
      bucket,
      '--endpoint-url',
      `https://${accountId}.r2.cloudflarestorage.com`,
      '--output',
      'json',
    ];
    if (dryRun) {
      console.log(`[dry run] aws ${full.join(' ')}`);
      return { status: 0, stderr: '' };
    }
    const result = spawnSync('aws', full, {
      encoding: 'utf8',
      // R2 takes region `auto`; checksums only where S3 requires them, which R2 accepts.
      env: {
        ...process.env,
        AWS_DEFAULT_REGION: 'auto',
        AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
        AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
      },
    });
    if (result.error) return { status: 1, stderr: String(result.error) };
    return { status: result.status, stderr: result.stderr ?? '' };
  };
  const put = (key, file, type, cacheControl, disposition) => {
    const args = [
      'put-object',
      '--key',
      key,
      '--body',
      file,
      '--content-type',
      type,
      '--cache-control',
      cacheControl,
    ];
    if (disposition) args.push('--content-disposition', disposition);
    const result = s3api(args);
    if (result.status !== 0) {
      console.error(result.stderr);
      console.error(`desktop-release: uploading ${key} failed`);
      process.exit(1);
    }
  };

  const label = channel === 'stable' ? version : 'nightly';
  const names = readdirSync(dir).sort();
  const files = [];
  const archives = [];
  for (const name of names) {
    if (name.endsWith('.sig')) {
      const base = name.slice(0, -'.sig'.length);
      if (!names.includes(base) || !(classify(base, label) || classifyUpdaterArchive(base, label))) {
        console.error(`desktop-release: ${name} signs no installer or updater archive in ${dir}`);
        process.exit(1);
      }
      continue;
    }
    const installer = classify(name, label);
    const kind = installer ?? classifyUpdaterArchive(name, label);
    if (!kind) {
      console.error(
        `desktop-release: ${name} is not an installer named PushForm-${label}-<platform><suffix>`,
      );
      process.exit(1);
    }
    const path = join(dir, name);
    const key = objectKey(channel, version, name);
    (installer ? files : archives).push({
      platform: kind.platform,
      format: kind.format,
      name,
      url: `${baseUrl}/${key}`,
      size: statSync(path).size,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      signature: names.includes(`${name}.sig`)
        ? readFileSync(join(dir, `${name}.sig`), 'utf8').trim()
        : null,
      path,
      key,
      type: kind.type,
    });
  }
  if (files.length === 0) {
    console.error(`desktop-release: no installers in ${dir}`);
    process.exit(1);
  }

  // Versioned stable files never change; nightly files are replaced in place.
  const fileCache =
    channel === 'stable' ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
  for (const f of [...files, ...archives]) {
    put(f.key, f.path, f.type, fileCache, `attachment; filename="${f.name}"`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'pushform-desktop-release-'));
  try {
    let index = null;
    if (channel === 'stable') {
      // Read the current index from the bucket, not the CDN, so a release minutes after another still sees it.
      const current = join(scratch, 'current.json');
      const got = s3api(['get-object', '--key', indexKey(channel), current]);
      if (got.status === 0 && !dryRun) index = JSON.parse(readFileSync(current, 'utf8'));
      else if (got.status !== 0 && !/NoSuchKey|Not Found|404/i.test(got.stderr)) {
        console.error(got.stderr);
        console.error('desktop-release: reading the release index failed');
        process.exit(1);
      }
    }
    const release = {
      version,
      commit,
      date: new Date().toISOString(),
      files: files.map(({ platform, format, name, url, size, sha256 }) => ({
        platform,
        format,
        name,
        url,
        size,
        sha256,
      })),
    };
    const next = withRelease(index, channel, release, release.date);
    const out = join(scratch, 'index.json');
    writeFileSync(out, `${JSON.stringify(next, null, 2)}\n`);
    if (dryRun) console.log(readFileSync(out, 'utf8'));
    put(indexKey(channel), out, 'application/json', 'public, max-age=60');
    console.log(
      `desktop-release: published ${channel} ${version} (${files.length} installers) to ${baseUrl}/${indexKey(channel)}`,
    );
    const signed = [...files, ...archives].filter((f) => f.signature);
    const manifest = updaterManifest(channel, version, release.date, signed);
    if (!manifest) {
      console.log(
        'desktop-release: no updater signatures, so no update manifest (the build had no updater key)',
      );
      return;
    }
    const latest = join(scratch, 'latest.json');
    writeFileSync(latest, `${JSON.stringify(manifest, null, 2)}\n`);
    if (dryRun) console.log(readFileSync(latest, 'utf8'));
    put(updaterKey(channel), latest, 'application/json', 'public, max-age=60');
    console.log(`desktop-release: published the update manifest ${baseUrl}/${updaterKey(channel)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
