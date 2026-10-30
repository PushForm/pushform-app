// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ConfigInput } from './schema.ts';

/** A complete valid configuration mirroring the PushForm values; for tests and fixtures. */
export const SAMPLE_CONFIG_INPUT: ConfigInput = {
  host: 'pushform',
  name: 'PushForm',
  tracker: {
    kind: 'linear', team: 'FRQ', project: 'Customer Features',
    problemDestination: { sameProject: true, label: 'defect' },
    states: {
      triage: 'Triage', build: 'Build', designReview: 'Design review', inProgress: 'In Progress', inTrial: 'In Trial',
      needsHuman: 'Needs Human', readyForReview: 'Ready for Review', done: 'Done', canceled: 'Canceled',
    },
  },
  repository: { kind: 'github', owner: 'PushForm', name: 'PushForm', defaultBranch: 'main', branchPrefix: 'frq', checks: ['typecheck', 'lint', 'test', 'license-check', 'build'], instructions: 'AGENTS.md' },
  deploy: { kind: 'cloudflare-pages', project: 'pushform-app', healthPath: '/healthz' },
  data: { kind: 'supabase-branch', fallback: { kind: 'fixed', env: 'staging' } },
  access: { kind: 'cloudflare-access', trustedDomains: ['pushform.io'] },
  mail: { kind: 'resend', from: 'requests@pushform.io', replyTo: 'support@pushform.io' },
  models: { conversation: 'claude-haiku-5-5', document: 'claude-sonnet-5-5', build: 'claude-opus-5-5' },
  roles: { defaultRole: 'user', admins: ['owner@example.com'], maintainers: ['team@example.com'] },
  boundaries: {
    treatments: { C1: 'allowed', C2: 'allowed', C3: 'allowed', C4: 'allowed', C5: 'review', C6: 'forbidden', C7: 'forbidden' },
    automaticCeiling: { builder: 'C3', maintainer: 'C4' },
    size: { maxFiles: 40, maxLines: 2000 },
    paths: {
      C1: ['docs/**', 'specs/**'],
      C5: ['supabase/migrations/**', 'packages/core/src/format/**', 'packages/cloud/src/CloudFiles*.ts'],
      C6: ['.github/**', 'apps/desktop/**', 'apps/web/vite.config.ts', 'package.json', 'pnpm-lock.yaml', 'scripts/**'],
      C7: ['packages/cloud/src/CloudSession*.ts', 'packages/cloud/src/browser.ts', 'supabase/**/*policy*', 'supabase/config.toml'],
    },
  },
  limits: {
    openRequestsPerAccount: 5, messagesPerConversation: 30, messagesPerMinute: 20, concurrentRuns: 2, runWallClockMinutes: 120,
    runBudgetUsd: 20, trialDays: 3, verdictGraceHours: 24, rounds: 2, dailyRuns: 6, liveDataBranches: 3,
  },
};
