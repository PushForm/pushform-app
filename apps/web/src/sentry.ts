// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { RootOptions } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { buildInfo } from './buildInfo';
import { sentryDsnFor } from './sentryDsn';

/**
 * Client error reporting to the Sentry project `jobcraft-inc/pushform`. The web
 * app and the desktop app share the project: they ship the same bundle, so they share the release and its source
 * maps, and the `shell` tag tells them apart. Production builds report to the project's DSN, which is public by design;
 * `VITE_SENTRY_DSN` overrides it, and set empty it turns reporting off. Development reports only when it is set.
 */
export interface SentrySettings {
  readonly dsn: string;
  readonly release: string;
  readonly environment: 'development' | 'production';
  readonly tracesSampleRate: number;
  readonly shell: 'web' | 'desktop';
}

export function sentrySettings(input: {
  dsn: string | undefined;
  release: string;
  dev: boolean;
  desktop: boolean;
}): SentrySettings | null {
  if (!input.dsn) return null;
  return {
    dsn: input.dsn,
    release: input.release,
    environment: input.dev ? 'development' : 'production',
    // Every trace while developing, so a check sees its own; a sample of real sessions otherwise.
    tracesSampleRate: input.dev ? 1 : 0.1,
    shell: input.desktop ? 'desktop' : 'web',
  };
}

const settings = sentrySettings({
  dsn: sentryDsnFor({ VITE_SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN as string | undefined }, import.meta.env.PROD),
  release: buildInfo.commit,
  dev: import.meta.env.DEV,
  desktop: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
});

if (settings) {
  Sentry.init({
    dsn: settings.dsn,
    release: settings.release,
    environment: settings.environment,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: settings.tracesSampleRate,
    // Trace headers stay on same-origin requests (the SDK default): Supabase's CORS rejects unknown headers.
    // Documents are private by default, so no user identity and no request or response bodies leave the app.
    dataCollection: { userInfo: false, httpBodies: [] },
    initialScope: { tags: { shell: settings.shell, version: buildInfo.version } },
  });
}

/**
 * React 19 root error hooks: report uncaught, boundary-caught and recovered render errors. Supplying a hook replaces
 * React's own console report, so each one logs as React would.
 */
const report = Sentry.reactErrorHandler((error, info) => console.error(error, info.componentStack ?? ''));
const handle = (error: unknown, info: { componentStack?: string | undefined }): void =>
  report(error, { componentStack: info.componentStack ?? null });
export const rootErrorHandlers: RootOptions = { onUncaughtError: handle, onCaughtError: handle, onRecoverableError: handle };
