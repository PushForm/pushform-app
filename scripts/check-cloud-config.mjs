// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global console, process */
// Release check of the cloud configuration a build bakes into public assets:
//   node scripts/check-cloud-config.mjs               before a build: the VITE_SUPABASE_* variables must give a
//                                                     project URL and a public (publishable or anon) key
//   node scripts/check-cloud-config.mjs <dist>...     after it: the built files must name that project's origin and
//                                                     carry no secret or service-role key
// Exits 1, naming what is wrong but never printing a key, before anything is uploaded or packaged.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseCloudConfig, serverCredentialsIn } from '../packages/cloud/src/cloudConfig.ts';

const TEXT = /\.(?:js|mjs|cjs|html|css|json|map|txt|svg|webmanifest)$/i;

function* textFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* textFiles(path);
    else if (TEXT.test(name)) yield path;
  }
}

/** Problems with the release configuration in `env` and, when given, the built `dirs`; empty when all is well. */
export function cloudConfigProblems(env, dirs = []) {
  let config;
  try {
    config = releaseCloudConfig(env);
  } catch (error) {
    return [`cloud configuration: ${error.message}`];
  }
  const problems = [];
  for (const dir of dirs) {
    let namesOrigin = false;
    for (const file of textFiles(dir)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes(config.url)) namesOrigin = true;
      for (const finding of serverCredentialsIn(text)) problems.push(`${file}: contains ${finding}`);
    }
    if (!namesOrigin) problems.push(`${dir}: no built file names the Supabase project ${config.url}`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dirs = process.argv.slice(2);
  const problems = cloudConfigProblems(process.env, dirs);
  for (const problem of problems) console.error(`FAIL ${problem}`);
  if (problems.length) process.exit(1);
  console.log(`ok   cloud configuration${dirs.length ? ` and ${dirs.join(', ')}` : ''}`);
}
