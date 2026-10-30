// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { sentrySettings } from './sentry';

const base = { dsn: 'https://key@o1.ingest.us.sentry.io/2', release: 'abc1234', dev: false, desktop: false };

describe('sentrySettings', () => {
  it('reports nothing without a DSN', () => {
    expect(sentrySettings({ ...base, dsn: undefined })).toBeNull();
    expect(sentrySettings({ ...base, dsn: '' })).toBeNull();
  });

  it('samples a tenth of production traces and tags the release', () => {
    expect(sentrySettings(base)).toEqual({ dsn: base.dsn, release: 'abc1234', environment: 'production', tracesSampleRate: 0.1, shell: 'web' });
  });

  it('separates development and trial builds from production', () => {
    expect(sentrySettings({ ...base, dev: true })).toMatchObject({ environment: 'development', tracesSampleRate: 1 });
  });

  it('tags the desktop app', () => {
    expect(sentrySettings({ ...base, desktop: true })).toMatchObject({ shell: 'desktop', environment: 'production' });
  });
});
