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
  const mark = readFileSync(join(desktop, 'src-tauri/icons/PushForm.icon/Assets/mark.svg'), 'utf8');
  const source = join(output, 'fallback.svg');
  writeFileSync(
    source,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <rect x="100" y="100" width="824" height="824" rx="184" fill="#fffdf7"/>
      <g transform="translate(100 100) scale(0.8046875)">${mark}</g>
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
