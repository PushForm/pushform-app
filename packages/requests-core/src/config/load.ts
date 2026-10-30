// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { z } from 'zod';
import { configSchema, type Config } from './schema.ts';

export type ConfigValidation = { ok: true; config: Config; errors: [] } | { ok: false; config: null; errors: string[] };

function describe(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.') || '(root)';
  const input = 'input' in issue ? (issue as { input?: unknown }).input : undefined;
  if (issue.code === 'invalid_type' && (input === undefined || /received undefined$/.test(issue.message))) return `${path}: Required`;
  if (issue.code === 'unrecognized_keys') return `${path}: Unknown key${issue.keys.length > 1 ? 's' : ''} ${issue.keys.map(k => `"${k}"`).join(', ')}`;
  if (issue.code === 'invalid_value') return `${path}: Expected one of ${issue.values.map(v => JSON.stringify(v)).join(', ')}`;
  if (issue.code === 'invalid_union' && issue.errors.length > 0) {
    const first = issue.errors[0] ?? [];
    const inner = first.map(e => describe({ ...e, path: [...issue.path, ...e.path] }));
    return inner.join('; ') || `${path}: Invalid value`;
  }
  return `${path}: ${issue.message}`;
}

/**
 * Validate a parsed `feature-requests.config.json`. Errors read as `path: message`, for
 * example `tracker.states.triage: Required`, so they can be pasted into an issue comment.
 */
export function validateConfig(value: unknown): ConfigValidation {
  const result = configSchema.safeParse(value, { reportInput: true });
  if (result.success) return { ok: true, config: result.data, errors: [] };
  const errors = [...new Set(result.error.issues.map(describe))];
  return { ok: false, config: null, errors };
}

/** Parse or throw; for cold starts where an invalid configuration must stop the function. */
export function loadConfig(value: unknown): Config {
  const result = validateConfig(value);
  if (!result.ok) throw new Error(`feature-requests.config.json is invalid:\n${result.errors.map(e => `  ${e}`).join('\n')}`);
  return result.config;
}

/**
 * Every configured state name must exist in the tracker team. Returns one readable error per
 * missing state; an empty array means the configuration passes.
 */
/** The filing project (and the separate problem project, when configured) must exist in the team. */
export function checkTrackerProjects(config: Config, projectNamesInTeam: readonly string[]): string[] {
  const present = new Set(projectNamesInTeam);
  const wanted: [string, string][] = [['tracker.project', config.tracker.project]];
  const problem = config.tracker.problemDestination;
  if (!problem.sameProject && problem.project) wanted.push(['tracker.problemDestination.project', problem.project]);
  return wanted.filter(([, name]) => !present.has(name)).map(([key, name]) => `${key}: project "${name}" does not exist in team ${config.tracker.team}`);
}
export function checkTrackerStates(config: Config, stateNamesInTeam: readonly string[]): string[] {
  const present = new Set(stateNamesInTeam);
  const lower = new Map(stateNamesInTeam.map(n => [n.toLowerCase(), n] as const));
  const errors: string[] = [];
  for (const key of ['triage', 'done', 'canceled'] as const) {
    const name = config.tracker.states[key];
    if (present.has(name)) continue;
    const near = lower.get(name.toLowerCase());
    const hint = near ? ` (the team has "${near}"; state names are case-sensitive)` : '';
    errors.push(`tracker.states.${key}: state "${name}" does not exist in team ${config.tracker.team}${hint}`);
  }
  return errors;
}

/** Stable hash of a validated configuration, recorded on the host row (`fr_hosts.config_hash`). */
export async function configHash(config: Config): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(config)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
