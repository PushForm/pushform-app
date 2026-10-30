// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import {
  classify,
  classifyUpdaterArchive,
  compareVersions,
  indexKey,
  objectKey,
  updaterKey,
  updaterManifest,
  withRelease,
} from './desktop-release.mjs';

const release = (version) => ({
  version,
  commit: 'abc',
  date: '2026-10-26T00:00:00.000Z',
  files: [],
});

describe('desktop-release', () => {
  it('recognizes installers by label, platform and suffix', () => {
    expect(classify('PushForm-26.44.44-windows-x64-setup.exe', '26.44.44')).toMatchObject({
      platform: 'windows-x64',
      format: 'exe',
    });
    expect(classify('PushForm-26.44.44-windows-x64.msi', '26.44.44')).toMatchObject({
      format: 'msi',
    });
    expect(classify('PushForm-nightly-macos-arm64.dmg', 'nightly')).toMatchObject({
      platform: 'macos-arm64',
      format: 'dmg',
    });
    expect(classify('PushForm-nightly-linux-x86_64.AppImage', 'nightly')).toMatchObject({
      platform: 'linux-x86_64',
      format: 'appimage',
    });
    expect(classify('PushForm-nightly-linux-x86_64.deb', '26.44.44')).toBeNull();
    expect(classify('PushForm_26.44.44_x64-setup.exe', '26.44.44')).toBeNull();
  });

  it('keys stable files by version and nightly files in place', () => {
    expect(objectKey('stable', '26.44.44', 'a.dmg')).toBe('desktop/stable/26.44.44/a.dmg');
    expect(objectKey('nightly', '26.44.44', 'a.dmg')).toBe('desktop/nightly/a.dmg');
    expect(indexKey('stable')).toBe('desktop/releases.json');
    expect(indexKey('nightly')).toBe('desktop/nightly.json');
  });

  it('keeps every stable release newest first and replaces a re-published version', () => {
    let index = withRelease(null, 'stable', release('26.44.9'), 't1');
    index = withRelease(index, 'stable', release('26.45.1'), 't2');
    index = withRelease(index, 'stable', release('26.44.10'), 't3');
    expect(index.releases.map((r) => r.version)).toEqual(['26.45.1', '26.44.10', '26.44.9']);
    index = withRelease(index, 'stable', { ...release('26.44.10'), commit: 'def' }, 't4');
    expect(index.releases.map((r) => r.version)).toEqual(['26.45.1', '26.44.10', '26.44.9']);
    expect(index.releases[1].commit).toBe('def');
    expect(index).toMatchObject({ channel: 'stable', updated: 't4' });
  });

  it('holds only the latest nightly', () => {
    const index = withRelease(
      withRelease(null, 'nightly', release('26.44.1'), 't1'),
      'nightly',
      release('26.44.2'),
      't2',
    );
    expect(index.releases.map((r) => r.version)).toEqual(['26.44.2']);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('26.44.10', '26.44.9')).toBeGreaterThan(0);
    expect(compareVersions('27.1.1', '26.53.40')).toBeGreaterThan(0);
    expect(compareVersions('26.44.1', '26.44.1')).toBe(0);
  });

  it('recognizes the macOS updater archive apart from installers', () => {
    expect(classifyUpdaterArchive('PushForm-nightly-macos-arm64.app.tar.gz', 'nightly')).toMatchObject({
      platform: 'macos-arm64',
      format: 'app',
    });
    expect(classify('PushForm-nightly-macos-arm64.app.tar.gz', 'nightly')).toBeNull();
    expect(classifyUpdaterArchive('PushForm-nightly-macos-arm64.dmg', 'nightly')).toBeNull();
    expect(updaterKey('stable')).toBe('desktop/stable/latest.json');
    expect(updaterKey('nightly')).toBe('desktop/nightly/latest.json');
  });

  it('writes the update manifest per updater target, with the first format as the fallback', () => {
    const base = 'https://downloads.pushform.io/desktop/stable/26.45.3';
    const signed = [
      { platform: 'windows-x64', format: 'exe', url: `${base}/a-setup.exe`, signature: 'sig-exe' },
      { platform: 'windows-x64', format: 'msi', url: `${base}/a.msi`, signature: 'sig-msi' },
      { platform: 'macos-arm64', format: 'app', url: `${base}/a.app.tar.gz`, signature: 'sig-app' },
      { platform: 'linux-x86_64', format: 'appimage', url: `${base}/a.AppImage`, signature: 'sig-appimage' },
      { platform: 'linux-x86_64', format: 'deb', url: `${base}/a.deb`, signature: 'sig-deb' },
    ];
    const manifest = updaterManifest('stable', '26.45.3', 'd', signed);
    expect(manifest).toMatchObject({ version: '26.45.3', pub_date: 'd' });
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      'darwin-aarch64',
      'darwin-aarch64-app',
      'linux-x86_64',
      'linux-x86_64-appimage',
      'linux-x86_64-deb',
      'windows-x86_64',
      'windows-x86_64-msi',
      'windows-x86_64-nsis',
    ]);
    expect(manifest.platforms['windows-x86_64']).toEqual({ signature: 'sig-exe', url: `${base}/a-setup.exe` });
    expect(manifest.platforms['linux-x86_64'].signature).toBe('sig-appimage');
    expect(manifest.platforms['darwin-aarch64-app'].url).toBe(`${base}/a.app.tar.gz`);
  });

  it('versions nightly update URLs so a cached file never meets a newer signature', () => {
    const manifest = updaterManifest('nightly', '26.45.4', 'd', [
      { platform: 'macos-arm64', format: 'app', url: 'https://x/desktop/nightly/a.app.tar.gz', signature: 's' },
    ]);
    expect(manifest.platforms['darwin-aarch64'].url).toBe('https://x/desktop/nightly/a.app.tar.gz?v=26.45.4');
  });

  it('writes no update manifest for a build without signatures', () => {
    expect(updaterManifest('stable', '26.45.3', 'd', [])).toBeNull();
  });
});
