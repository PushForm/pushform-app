// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Product version `<yr>.<week>.<increment>`: the two-digit ISO 8601 week-year and ISO week of the built
 * commit's committer time in UTC, and the count of commits in that week along its first-parent history, the commit
 * itself included. Every build of one commit gets the same version, and versions increase along `main`. Three numeric
 * fields keep it a valid semver and Windows MSI version (major ≤ 255, minor ≤ 255, build ≤ 65535).
 *
 * Read by vite.config.ts for About PushForm and by .github/workflows/desktop.yml, which runs this file with Node
 * (`node --experimental-strip-types apps/web/buildVersion.ts`) to version the installers and check release tags.
 */

const DAY_MS = 86_400_000;

/** ISO 8601 week-year and week (1–53) of a UTC instant. */
export function isoWeek(ms: number): { year: number; week: number } {
  const date = new Date(ms);
  const day = (date.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  // The Thursday of this week decides which year the week belongs to.
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  return { year, week: 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) };
}

/**
 * Version from committer times (ms) in first-parent order, newest first; the first entry is the built commit. `complete`
 * says the list reaches past the start of that week (or is the whole history); a shallow clone that does not yields null.
 */
export function versionFromCommitTimes(times: readonly number[], complete = true): string | null {
  const head = times[0];
  if (head === undefined) return null;
  const { year, week } = isoWeek(head);
  let increment = 0;
  for (const time of times) {
    const other = isoWeek(time);
    if (other.year !== year || other.week !== week) break;
    increment++;
  }
  if (increment === times.length && !complete) return null;
  return `${year % 100}.${week}.${increment}`;
}

/** Version of the checkout's HEAD, or null when git is unavailable or a shallow clone lacks the week's history. */
export function gitVersion(repoRoot: string): string | null {
  const git = (args: string): string | null => {
    try {
      return execSync(`git ${args}`, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  // A week holds far fewer than 2,000 commits; the limit only bounds the read.
  const log = git('log --first-parent --max-count=2000 --format=%ct HEAD');
  if (!log) return null;
  const times = log.split('\n').map((seconds) => Number(seconds) * 1000);
  return versionFromCommitTimes(times, git('rev-parse --is-shallow-repository') !== 'true');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = gitVersion(fileURLToPath(new URL('../..', import.meta.url)));
  if (!version) {
    console.error('Cannot determine the version: no git history, or a shallow clone missing this week (fetch-depth: 0).');
    process.exit(1);
  }
  console.log(version);
}
