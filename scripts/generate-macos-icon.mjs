#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

// Regenerate only the macOS bundle icon from its editable vector source.
const desktop = fileURLToPath(new URL('../apps/desktop/', import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'pushform-macos-icon-'));
try {
  execFileSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tauri', 'icon', 'src-tauri/icons/macos-icon.svg', '--output', output],
    { cwd: desktop, stdio: 'inherit' },
  );
  copyFileSync(join(output, 'icon.icns'), join(desktop, 'src-tauri/icons/icon.icns'));
} finally {
  rmSync(output, { recursive: true, force: true });
}
