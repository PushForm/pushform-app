#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global console, process */
// Adds the SPDX license tag to first-party source files. `--check` only reports files without it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';

const TAG = ['SPDX-License-Identifier: GPL-3.0-or-later', 'Copyright 2026 PushForm contributors'];
const STYLE = { '.ts': '//', '.tsx': '//', '.mjs': '//', '.js': '//', '.cjs': '//', '.rs': '//', '.sql': '--', '.css': 'block' };
// Generated output and reference tooling are not first-party source for the release.
const SKIP = [/(^|\/)db\.types\.ts$/, /(^|\/)node_modules\//];

const check = process.argv.includes('--check');
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
const missing = [];

for (const file of files) {
  const style = STYLE[extname(file)];
  // A tracked file deleted in the working tree is not there to read.
  if (!style || SKIP.some((pattern) => pattern.test(file)) || !existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (text.slice(0, 600).includes('SPDX-License-Identifier:')) continue;
  missing.push(file);
  if (check) continue;
  const header = style === 'block' ? `/* ${TAG[0]}\n * ${TAG[1]} */\n` : TAG.map((line) => `${style} ${line}\n`).join('');
  const shebang = text.startsWith('#!') ? text.slice(0, text.indexOf('\n') + 1) : '';
  writeFileSync(file, shebang + header + text.slice(shebang.length));
}

if (check && missing.length > 0) {
  console.error(`Missing SPDX tag in ${missing.length} file(s):\n${missing.join('\n')}`);
  process.exit(1);
}
console.log(check ? 'All first-party source files carry the SPDX tag.' : `Tagged ${missing.length} file(s).`);
