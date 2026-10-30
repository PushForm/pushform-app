// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { globError } from '../domain/classes.ts';

/**
 * Schema of `feature-requests.config.json`. Objects are strict so a misspelled
 * key fails validation instead of silently falling back to a default. Defaults follow the values the
 * specification states (sizes, limits, checks and instructions file).
 */
const changeClass = z.enum(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']);
const treatment = z.enum(['allowed', 'review', 'forbidden']);
const email = z.string().trim().toLowerCase().email();
const nonEmpty = z.string().trim().min(1);

export const trackerStatesSchema = z.strictObject({
  triage: nonEmpty, done: nonEmpty, canceled: nonEmpty,
  // Historical keys are accepted for reading old records; they are not required integrations.
  build: nonEmpty.default('Build'), designReview: nonEmpty.default('Design review'), inProgress: nonEmpty.default('In Progress'),
  inTrial: nonEmpty.default('In Trial'), needsHuman: nonEmpty.default('Needs Human'), readyForReview: nonEmpty.default('Ready for Review'),
});
/** Where problem reports go: the same project with a label, or another project of the team. */
export const problemDestinationSchema = z.strictObject({
  sameProject: z.boolean().default(true),
  project: nonEmpty.optional(),
  label: nonEmpty.default('defect'),
}).refine(d => d.sameProject || d.project !== undefined, { message: 'project is required when sameProject is false', path: ['project'] });
export const trackerConfigSchema = z.strictObject({
  kind: z.literal('linear'),
  team: nonEmpty,
  project: nonEmpty,
  problemDestination: problemDestinationSchema.prefault({}),
  states: trackerStatesSchema,
});
export const repositoryConfigSchema = z.strictObject({
  kind: z.literal('github'),
  owner: nonEmpty,
  name: nonEmpty,
  defaultBranch: nonEmpty.default('main'),
  branchPrefix: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens').default('frq'),
  checks: z.array(nonEmpty).default(['typecheck', 'lint', 'test', 'license-check', 'build']),
  instructions: nonEmpty.default('AGENTS.md'),
});
const hostname = z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, 'a hostname such as preview.example.com');
export const deployConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('cloudflare-pages'),
    project: nonEmpty,
    healthPath: z.string().startsWith('/').default('/healthz'),
    alias: z.string().optional(),
    /** Trials are addressed as `https://<alias>.<previewDomain>`, served by workers/trial-proxy; without it, the `pages.dev` alias. */
    previewDomain: hostname.optional(),
  }),
  z.strictObject({ kind: z.literal('command'), deploy: nonEmpty, destroy: nonEmpty, urlPattern: nonEmpty, healthPath: z.string().startsWith('/').default('/healthz') }),
]);
const fixedData = z.strictObject({ kind: z.literal('fixed'), env: nonEmpty });
export const dataConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('supabase-branch'), fallback: fixedData.optional() }),
  fixedData,
]);
export const accessConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cloudflare-access'), trustedDomains: z.array(nonEmpty.toLowerCase()).default([]) }),
  z.strictObject({ kind: z.literal('none'), trustedDomains: z.array(nonEmpty.toLowerCase()).default([]) }),
]);
export const mailConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('resend'), from: email, replyTo: email }),
  z.strictObject({ kind: z.literal('smtp'), host: nonEmpty, port: z.int().min(1).max(65535).default(587), from: email, replyTo: email }),
]);
export const modelsConfigSchema = z.strictObject({
  conversation: nonEmpty.default('claude-haiku-5-5'),
  /** Turns that offer document tools: the open document makes the turn multi-step geometry work. */
  document: nonEmpty.default('claude-sonnet-5-5'),
  build: nonEmpty.default('claude-opus-5-5'),
});
export const rolesConfigSchema = z.strictObject({
  defaultRole: z.enum(['user', 'none']).default('user'),
  admins: z.array(email).default([]),
  maintainers: z.array(email).default([]),
  /** Membership endpoint of; absent means the host has only the global scope. */
  membership: z.url().optional(),
});
export const boundariesConfigSchema = z.strictObject({
  treatments: z.strictObject({
    C1: treatment.default('allowed'), C2: treatment.default('allowed'), C3: treatment.default('allowed'), C4: treatment.default('allowed'),
    C5: treatment.default('review'), C6: treatment.default('forbidden'), C7: treatment.default('forbidden'),
  }).prefault({}),
  automaticCeiling: z.strictObject({ builder: changeClass.default('C3'), maintainer: changeClass.default('C4') }).prefault({}),
  size: z.strictObject({ maxFiles: z.int().positive().default(40), maxLines: z.int().positive().default(2000) }).prefault({}),
  paths: z.partialRecord(changeClass, z.array(nonEmpty.superRefine((pattern, ctx) => { const e = globError(pattern); if (e) ctx.addIssue({ code: 'custom', message: e }); }))).default({}),
});
export const limitsConfigSchema = z.strictObject({
  openRequestsPerAccount: z.int().positive().default(5),
  messagesPerConversation: z.int().positive().default(30),
  messagesPerMinute: z.int().positive().default(20),
  concurrentRuns: z.int().positive().default(2),
  runWallClockMinutes: z.int().positive().default(120),
  /** The per-run spending cap in US dollars, metered from the build model's list prices. */
  runBudgetUsd: z.number().positive().default(20),
  trialDays: z.int().positive().max(3).default(3),
  verdictGraceHours: z.int().positive().default(24),
  rounds: z.int().min(0).default(2),
  dailyRuns: z.int().positive().default(6),
  liveDataBranches: z.int().positive().default(3),
});

export const configSchema = z.strictObject({
  $schema: z.string().optional(),
  host: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens'),
  name: nonEmpty,
  tracker: trackerConfigSchema,
  repository: repositoryConfigSchema.prefault({ kind: 'github', owner: 'retired', name: 'retired' }),
  deploy: deployConfigSchema.prefault({ kind: 'cloudflare-pages', project: 'retired' }),
  data: dataConfigSchema.prefault({ kind: 'fixed', env: 'retired' }),
  access: accessConfigSchema.prefault({ kind: 'none' }),
  mail: mailConfigSchema,
  models: modelsConfigSchema.prefault({}),
  roles: rolesConfigSchema.prefault({}),
  boundaries: boundariesConfigSchema.prefault({}),
  limits: limitsConfigSchema.prefault({}),
});
export type Config = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;
export type TrackerConfig = Config['tracker'];
export type TrackerStates = Config['tracker']['states'];
export type BoundariesConfig = Config['boundaries'];
export type LimitsConfig = Config['limits'];
export type RolesConfig = Config['roles'];

/** JSON Schema (draft 2020-12) published next to the package for editors and the `$schema` key. */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(configSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
  return { ...schema, $id: 'https://pushform.io/schemas/feature-requests.config.schema.json', title: 'feature-requests.config.json' };
}
