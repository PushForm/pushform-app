// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configJsonSchema, configSchema } from './schema.ts';
import { SAMPLE_CONFIG_INPUT } from './sample.ts';

const ROOT = new URL('../../../../', import.meta.url);
const rootConfig = JSON.parse(readFileSync(new URL('feature-requests.config.json', ROOT), 'utf8')) as unknown;

describe('configSchema', () => {
  it('accepts the repository configuration file with every key', () => {
    const result = configSchema.safeParse(rootConfig);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data?.host).toBe('pushform');
    expect(result.data?.roles.maintainers).toEqual(['testers@pushform.io']);
    expect(result.data?.models).toEqual({ conversation: 'claude-haiku-5-5', document: 'claude-sonnet-5-5', build: 'claude-opus-5-5' });
    expect(result.data?.mail).toEqual({ kind: 'resend', from: 'requests@pushform.io', replyTo: 'support@pushform.io' });
    expect(result.data?.limits.messagesPerConversation).toBe(30);
    expect(result.data?.limits.messagesPerMinute).toBe(20);
  });
  it('accepts the sample input', () => { expect(configSchema.safeParse(SAMPLE_CONFIG_INPUT).success).toBe(true); });
  it('fills the limits, treatments, ceiling and sizes with their defaults', () => {
    const { models: _m, roles: _r, boundaries: _b, limits: _l, ...minimal } = SAMPLE_CONFIG_INPUT;
    const config = configSchema.parse(minimal);
    expect(config.limits).toEqual({
      openRequestsPerAccount: 5, messagesPerConversation: 30, messagesPerMinute: 20, concurrentRuns: 2, runWallClockMinutes: 120,
      runBudgetUsd: 20, trialDays: 3, verdictGraceHours: 24, rounds: 2, dailyRuns: 6, liveDataBranches: 3,
    });
    expect(config.boundaries.treatments).toEqual({ C1: 'allowed', C2: 'allowed', C3: 'allowed', C4: 'allowed', C5: 'review', C6: 'forbidden', C7: 'forbidden' });
    expect(config.boundaries.automaticCeiling).toEqual({ builder: 'C3', maintainer: 'C4' });
    expect(config.boundaries.size).toEqual({ maxFiles: 40, maxLines: 2000 });
    expect(config.boundaries.paths).toEqual({});
    expect(config.roles).toEqual({ defaultRole: 'user', admins: [], maintainers: [] });
    expect(config.models).toEqual({ conversation: 'claude-haiku-5-5', document: 'claude-sonnet-5-5', build: 'claude-opus-5-5' });
  });
  it('defaults repository checks and instructions and the problem destination', () => {
    const config = configSchema.parse({
      ...SAMPLE_CONFIG_INPUT,
      repository: { kind: 'github', owner: 'o', name: 'n' },
      tracker: { ...SAMPLE_CONFIG_INPUT.tracker, problemDestination: undefined },
    });
    expect(config.repository).toEqual({ kind: 'github', owner: 'o', name: 'n', defaultBranch: 'main', branchPrefix: 'frq', checks: ['typecheck', 'lint', 'test', 'license-check', 'build'], instructions: 'AGENTS.md' });
    expect(config.tracker.problemDestination).toEqual({ sameProject: true, label: 'defect' });
  });
  it('lower-cases emails and trusted domains', () => {
    const config = configSchema.parse({ ...SAMPLE_CONFIG_INPUT, roles: { admins: ['Owner@Example.com'] }, access: { kind: 'cloudflare-access', trustedDomains: ['PushForm.io'] } });
    expect(config.roles.admins).toEqual(['owner@example.com']);
    expect(config.access.trustedDomains).toEqual(['pushform.io']);
  });
  it('rejects unknown keys, bad state names, a separate problem project without a name, and trials over 3 days', () => {
    expect(configSchema.safeParse({ ...SAMPLE_CONFIG_INPUT, extra: 1 }).success).toBe(false);
    expect(configSchema.safeParse({ ...SAMPLE_CONFIG_INPUT, tracker: { ...SAMPLE_CONFIG_INPUT.tracker, states: { ...SAMPLE_CONFIG_INPUT.tracker.states, done: '' } } }).success).toBe(false);
    expect(configSchema.safeParse({ ...SAMPLE_CONFIG_INPUT, tracker: { ...SAMPLE_CONFIG_INPUT.tracker, problemDestination: { sameProject: false } } }).success).toBe(false);
    expect(configSchema.safeParse({ ...SAMPLE_CONFIG_INPUT, tracker: { ...SAMPLE_CONFIG_INPUT.tracker, problemDestination: { sameProject: false, project: 'Defects' } } }).success).toBe(true);
    expect(configSchema.safeParse({ ...SAMPLE_CONFIG_INPUT, limits: { trialDays: 4 } }).success).toBe(false);
    expect(configSchema.safeParse({ ...SAMPLE_CONFIG_INPUT, repository: { ...SAMPLE_CONFIG_INPUT.repository, branchPrefix: 'Bad/Prefix' } }).success).toBe(false);
  });
  it('accepts the other adapter kinds', () => {
    const config = configSchema.parse({
      ...SAMPLE_CONFIG_INPUT,
      deploy: { kind: 'command', deploy: './deploy.sh', destroy: './destroy.sh', urlPattern: 'https://{slug}.trials.example.com' },
      data: { kind: 'fixed', env: 'staging' },
      access: { kind: 'none' },
      mail: { kind: 'smtp', host: 'smtp.example.com', from: 'a@example.com', replyTo: 'b@example.com' },
    });
    expect(config.deploy.kind).toBe('command');
    expect(config.deploy.healthPath).toBe('/healthz');
    expect(config.access).toEqual({ kind: 'none', trustedDomains: [] });
    expect(config.mail.kind === 'smtp' && config.mail.port).toBe(587);
  });
  it('accepts a hostname as the trial preview domain and rejects anything else', () => {
    const deploy = { kind: 'cloudflare-pages', project: 'pushform-app', previewDomain: 'Preview.PushForm.io ' };
    expect(configSchema.parse({ ...SAMPLE_CONFIG_INPUT, deploy }).deploy).toMatchObject({ previewDomain: 'preview.pushform.io' });
    expect(configSchema.parse({ ...SAMPLE_CONFIG_INPUT, deploy: { kind: 'cloudflare-pages', project: 'pushform-app' } }).deploy).not.toHaveProperty('previewDomain');
    for (const bad of ['https://preview.pushform.io', 'preview', '-x.pushform.io', 'a b.io']) expect(() => configSchema.parse({ ...SAMPLE_CONFIG_INPUT, deploy: { ...deploy, previewDomain: bad } })).toThrow();
    expect(configSchema.parse(rootConfig).deploy).toMatchObject({ project: 'retired' });
  });
  it('publishes the JSON Schema the config file points at, in sync with the zod schema', () => {
    const published = JSON.parse(readFileSync(new URL('packages/requests-core/schema/feature-requests.config.schema.json', ROOT), 'utf8')) as Record<string, unknown>;
    expect(published).toEqual(configJsonSchema());
    expect((rootConfig as { $schema: string }).$schema).toBe('./packages/requests-core/schema/feature-requests.config.schema.json');
    expect(published['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    const states = (published as { properties: { tracker: { properties: { states: { required: string[] } } } } }).properties.tracker.properties.states;
    expect(states.required).toEqual(['triage', 'done', 'canceled']);
  });
});
