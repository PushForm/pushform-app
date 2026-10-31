#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

// Regenerate the legacy macOS fallback from the same SVG used by the native icon.
// Tauri compiles PushForm.icon with actool when bundling on macOS with Xcode 26+.
const desktop = fileURLToPath(new URL('../apps/desktop/', import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'pushform-macos-icon-'));
try {
  const icon = join(desktop, 'src-tauri/icons/PushForm.icon');
  const config = JSON.parse(readFileSync(join(icon, 'icon.json'), 'utf8'));
  const color = (value) => {
    if (!value.startsWith('extended-srgb:')) throw new Error('Expected an sRGB icon background');
    return `rgb(${value
      .split(':')[1]
      .split(',')
      .slice(0, 3)
      .map((n) => Math.round(Number(n) * 255))
      .join(',')})`;
  };
  const gradient = config.fill['linear-gradient'];
  const background = gradient
    ? `<linearGradient id="tileFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color(gradient[0])}"/><stop offset="1" stop-color="${color(gradient[1])}"/></linearGradient>`
    : '';
  const fill = gradient ? 'url(#tileFill)' : color(config.fill.solid);
  // Icon Composer lists frontmost groups first; SVG paints back to front.
  const layers = config.groups
    .toReversed()
    .flatMap((group) => group.layers.toReversed())
    .map((layer) => readFileSync(join(icon, 'Assets', layer['image-name']), 'utf8'))
    .join('\n');
  const source = join(output, 'fallback.svg');
  writeFileSync(
    source,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <defs>${background}<clipPath id="tileClip"><rect x="100" y="100" width="824" height="824" rx="184"/></clipPath></defs>
      <rect x="100" y="100" width="824" height="824" rx="184" fill="${fill}"/>
      <g clip-path="url(#tileClip)"><g transform="translate(100 100) scale(0.8046875)">${layers}</g></g>
    </svg>`,
  );
  execFileSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tauri', 'icon', source, '--output', output],
    { cwd: desktop, stdio: 'inherit' },
  );
  copyFileSync(join(output, 'icon.icns'), join(desktop, 'src-tauri/icons/icon.icns'));
} finally {
  rmSync(output, { recursive: true, force: true });
}
