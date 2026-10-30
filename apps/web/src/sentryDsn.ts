// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * The Sentry project's DSN, public by design. Shared by src/sentry.ts (run time) and
 * contentSecurityPolicy.ts (build time), whose policy allows it and reports violations to it; keep it free of browser
 * or Node specifics.
 */
export const PRODUCTION_SENTRY_DSN = 'https://a2f78afa4c19ca41aa65fbd037522489@o4512324800806912.ingest.us.sentry.io/4512324821385216';

/** The DSN a build reports to: `VITE_SENTRY_DSN` when set (empty turns reporting off), else the project's in production. */
export function sentryDsnFor(env: { VITE_SENTRY_DSN?: string | undefined }, production: boolean): string | undefined {
  return env.VITE_SENTRY_DSN ?? (production ? PRODUCTION_SENTRY_DSN : undefined);
}
