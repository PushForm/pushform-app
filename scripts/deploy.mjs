// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global console, process, URL */
// Manual deploy to Cloudflare Pages. Exports the committed tree of HEAD
// into a temporary worktree (so uncommitted work in this checkout never ships), installs, builds
// with VITE_RELEASE set to the short SHA, uploads the source maps to Sentry when SENTRY_AUTH_TOKEN
// is set, strips them, and uploads apps/web/dist as a deployment of the current branch.
//   pnpm deploy:pages                      # branch = current branch (main → production)
//   pnpm deploy:pages -- --branch staging  # upload under another branch name
//   pnpm deploy:pages -- --working-tree    # build this checkout as-is instead of HEAD
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT = 'pushform-app';
const repo = resolve(new URL('..', import.meta.url).pathname);

const git = (args, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim();
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const branch = flag('--branch') ?? git('rev-parse --abbrev-ref HEAD');
const sha = git('rev-parse HEAD');
const useWorkingTree = argv.includes('--working-tree');
const dirty = git('status --porcelain') !== '';

const run = (cmd, args, cwd, env = {}) => {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) {
    console.error(`deploy: ${cmd} ${args.join(' ')} exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
};
const stripMaps = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) stripMaps(p);
    else if (name.endsWith('.map')) rmSync(p);
  }
};

let buildRoot = repo;
let worktree = null;
if (useWorkingTree) {
  if (dirty) console.warn('deploy: building the working tree, which has uncommitted changes');
} else {
  worktree = mkdtempSync(join(tmpdir(), 'pushform-deploy-'));
  git(`worktree add --detach ${JSON.stringify(worktree)} ${sha}`);
  buildRoot = worktree;
  if (dirty)
    console.log('deploy: uncommitted changes in this checkout are not included (building HEAD)');
}

try {
  console.log(`deploy: building ${branch} @ ${sha.slice(0, 7)} in ${buildRoot}`);
  if (worktree) run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], buildRoot);
  run('pnpm', ['build'], buildRoot, { VITE_RELEASE: sha.slice(0, 7) });
  const dist = join(buildRoot, 'apps/web/dist');
  run('node', [join(repo, 'scripts/sentry-sourcemaps.mjs'), dist], buildRoot, { VITE_RELEASE: sha.slice(0, 7) });
  stripMaps(dist);
  run(
    'pnpm',
    [
      'exec',
      'wrangler',
      'pages',
      'deploy',
      dist,
      '--project-name',
      PROJECT,
      '--branch',
      branch,
      '--commit-hash',
      sha,
      '--commit-dirty',
      String(useWorkingTree && dirty),
    ],
    repo,
  );
} finally {
  if (worktree) {
    git(`worktree remove --force ${JSON.stringify(worktree)}`);
    rmSync(worktree, { recursive: true, force: true });
  }
}
