// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global process, console */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

export function readProjects(root = '.') {
  const projects = [];
  for (const parent of ['packages', 'apps', 'workers']) {
    if (!existsSync(`${root}/${parent}`)) continue;
    for (const entry of readdirSync(`${root}/${parent}`, { withFileTypes: true })) {
      const path = `${parent}/${entry.name}`;
      if (!entry.isDirectory() || !existsSync(`${root}/${path}/package.json`)) continue;
      const manifest = JSON.parse(readFileSync(`${root}/${path}/package.json`, 'utf8'));
      const config = `${root}/${path}/tsconfig.json`;
      const references = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')).references ?? [] : [];
      projects.push({ path, name: manifest.name, typecheck: existsSync(config),
        dependencies: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }),
        references: references.map(ref => posix.normalize(`${path}/${ref.path}`)) });
    }
  }
  return projects;
}

export function planChanges(files, projects) {
  const selected = new Set();
  let full = files === null;
  for (const file of files ?? []) {
    // Root documentation does not change application behavior or build inputs.
    if (/^(docs\/|README(?:\.[^/]*)?$)/.test(file)) continue;
    if (file.startsWith('crates/')) { selected.add('packages/io'); continue; }
    const project = projects.find(p => file.startsWith(`${p.path}/`));
    if (project && project.path !== 'apps/desktop' && !/(^|\/)(package\.json|tsconfig[^/]*\.json)$/.test(file)) selected.add(project.path);
    else full = true; // Unknown paths, dependency/config changes and CI tooling run the complete suite.
  }
  if (full) for (const project of projects) selected.add(project.path);
  for (let previous = -1; previous !== selected.size;) {
    previous = selected.size;
    const names = new Set(projects.filter(p => selected.has(p.path)).map(p => p.name));
    for (const project of projects) {
      if (project.dependencies.some(name => names.has(name)) || project.references.some(path => selected.has(path))) selected.add(project.path);
    }
  }
  const paths = [...selected].sort();
  return { full, paths, typecheck: projects.filter(p => selected.has(p.path) && p.typecheck).map(p => p.path).sort(),
    tests: full ? ['.'] : paths, lint: full ? ['.'] : paths,
    web: selected.has('apps/web'), commons: selected.has('apps/commons'),
    wasm: full || selected.has('packages/io') || selected.has('apps/web') };
}

export function runTask(task, plan) {
  const commands = {
    test: ['node_modules/vitest/vitest.mjs', 'run', '--passWithNoTests', ...plan.tests],
    lint: ['node_modules/eslint/bin/eslint.js', ...plan.lint],
    typecheck: ['node_modules/typescript/bin/tsc', '-b', ...plan.typecheck],
  };
  const paths = task === 'test' ? plan.tests : plan[task];
  if (!paths?.length) { console.log(`No affected ${task} inputs.`); return; }
  const result = spawnSync(process.execPath, commands[task], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'plan') runTask(process.argv[2], JSON.parse(process.env.CI_PLAN));
  else {
    let files = null;
    const base = process.env.CI_BASE;
    if (/^[a-f0-9]{40}$/.test(base ?? '')) {
      try {
        const from = process.env.CI_PULL_REQUEST === 'true'
          ? execFileSync('git', ['merge-base', base, 'HEAD'], { encoding: 'utf8' }).trim() : base;
        files = execFileSync('git', ['diff', '--name-only', '-z', from, 'HEAD'], { encoding: 'utf8' }).split('\0').filter(Boolean);
      } catch { console.log('Baseline unavailable; running all checks.'); }
    }
    const plan = planChanges(files, readProjects());
    console.log(JSON.stringify(plan, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `plan=${JSON.stringify(plan)}\nchecks=${plan.paths.length > 0}\nweb=${plan.web}\ncommons=${plan.commons}\nwasm=${plan.wasm}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### CI scope\n\n${plan.full ? 'Full validation (new or uncertain baseline/configuration).' : 'Affected projects and their transitive dependents.'}\n\n${plan.paths.join(', ') || 'Documentation only.'}\n`);
  }
}
