// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { cloudProfileComplete, type CloudProfileStore, type CloudSession, type UsageEvent, type UsageSink } from '@pushform/cloud';

import { ANALYTICS_HOST } from './productAnalyticsHost';
const kinds = new Set(['session_start', 'home_view', 'document_open', 'document_create', 'document_close', 'tool_use', 'help_open', 'help_message']);
const groups = new Set(['sketch', 'pushpull', 'solids', 'transform', 'selection', 'camera', 'view', 'file', 'layout', 'styles', 'tags', 'scenes', 'text', 'dimension', 'measure', 'tool', 'edit', 'help']);
const buildValue = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._+-]{1,80}$/.test(value);
const bounded = (value: unknown, max: number): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), max) : undefined;

/** Fixed properties only. No document names, account IDs, arguments, chat text or URLs enter this payload. */
export function analyticsEvent(event: UsageEvent, shell: 'web' | 'desktop', userAgent: string) {
  if (!kinds.has(event.kind) || !Number.isFinite(Date.parse(event.at))) return null;
  const properties: Record<string, string | number | boolean> = {
    distinct_id: '$posthog_cookieless', $cookieless_mode: true, $process_person_profile: false,
    // The cookieless pipeline needs these hash inputs and removes the raw user agent after hashing.
    $host: shell === 'web' ? 'app.pushform.io' : 'desktop.pushform.io', $raw_user_agent: userAgent,
    $lib: 'pushform', surface: 'app', shell,
  };
  if (event.documentType === 'model' || event.documentType === 'layout') properties.document_type = event.documentType;
  if (buildValue(event.appVersion)) properties.app_version = event.appVersion;
  if (buildValue(event.appBuild)) properties.app_build = event.appBuild;
  if (event.kind === 'tool_use') {
    const group = event.tool?.split('.')[0] ?? '';
    properties.tool_group = groups.has(group) ? group : 'other';
    properties.count = bounded(event.count ?? 1, 10_000) ?? 1;
  }
  if (event.kind === 'document_close') {
    const duration = bounded(event.durationSeconds, 86_400);
    if (duration !== undefined) properties.duration_seconds = duration;
  }
  return { event: `app_${event.kind}`, timestamp: event.at, properties };
}

export interface AnalyticsOptions {
  token: string | undefined;
  production: boolean;
  hostname: string;
  desktop: boolean;
  privacy: () => { dnt?: string | null | undefined; windowDnt?: string | null | undefined; gpc?: boolean | undefined };
  userAgent: () => string;
  transport?: typeof fetch;
}

/**
 * Owner-bound usage sink. Consent is read at send time, and pre-choice events are discarded.
 * The small explicit batch uses the public ingestion API: no SDK, storage, retries or third-party scripts.
 * A failed analytics request never retries cloud events or interrupts the app.
 */
export function productUsageForOwner(primary: UsageSink | undefined, session: Pick<CloudSession, 'getSnapshot'>,
  profiles: Pick<CloudProfileStore, 'getSnapshot'> | undefined, options: AnalyticsOptions): (owner: string) => UsageSink {
  return owner => {
    const sent = new WeakSet<UsageEvent>();
    return { async send(events) {
      const currentOwner = (): boolean => {
        const current = session.getSnapshot();
        return current.status === 'signedIn' && current.user?.id === owner;
      };
      if (!currentOwner()) return;
      const p = profiles?.getSnapshot();
      const decision = p?.status === 'ready' && p.ownerId === owner && p.profile && cloudProfileComplete(p.profile)
        && p.profile.analyticsOptIn === true ? p.profile.analyticsUpdatedAt : null;
      const since = decision ? Date.parse(decision) : NaN;
      const privacy = options.privacy();
      const enabled = options.production && !!options.token && (options.desktop || options.hostname === 'app.pushform.io')
        && !privacy.gpc && privacy.dnt !== '1' && privacy.windowDnt !== '1';
      if (enabled && Number.isFinite(since)) {
        const fresh = events.filter(event => !sent.has(event) && Date.parse(event.at) >= since);
        const batch = fresh.map(event => analyticsEvent(event, options.desktop ? 'desktop' : 'web', options.userAgent())).filter(event => event !== null);
        if (batch.length) {
          fresh.forEach(event => sent.add(event));
          // Start synchronously while this owner's submitted consent is current. No offline replay queue.
          try {
            void (options.transport ?? fetch)(`${ANALYTICS_HOST}/batch/`, {
              method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ api_key: options.token, batch }),
            }).catch(() => { /* Optional analytics must not affect editing or operational usage. */ });
          } catch { /* An unavailable transport is harmless. */ }
        }
      }
      await primary?.send(events);
    } };
  };
}
