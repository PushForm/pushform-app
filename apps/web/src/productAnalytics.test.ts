// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { CLOUD_TERMS_VERSION, type CloudProfileState, type CloudSessionState, type UsageEvent } from '@pushform/cloud';
import { analyticsEvent, productUsageForOwner, type AnalyticsOptions } from './productAnalytics';
const at = '2026-11-04T06:00:00Z';
const event: UsageEvent = { kind: 'document_create', at, documentType: 'model' };
function fixture(overrides: Partial<AnalyticsOptions> = {}) {
  let owner: string | null = 'alice';
  let state = { status: 'ready', ownerId: 'alice', saving: false, error: null,
    profile: { termsVersion: CLOUD_TERMS_VERSION, analyticsOptIn: null, analyticsUpdatedAt: null } } as CloudProfileState;
  const transport = vi.fn().mockResolvedValue({ ok: true });
  const primary = { send: vi.fn().mockResolvedValue(undefined) };
  let privacy = {};
  const options: AnalyticsOptions = { token: 'public-fixture', production: true, hostname: 'app.pushform.io', desktop: false,
    privacy: () => privacy, userAgent: () => 'Browser fixture', transport, ...overrides };
  const sink = productUsageForOwner(primary, { getSnapshot: () => ({ status: owner ? 'signedIn' : 'signedOut', user: owner ? { id: owner } : null }) as CloudSessionState },
    { getSnapshot: () => state }, options)('alice');
  return { sink, transport, primary, setOwner: (value: string | null) => { owner = value; },
    setPrivacy: (value: object) => { privacy = value; },
    decide: (optIn: boolean | null) => { state = { ...state, profile: { ...state.profile!, analyticsOptIn: optIn, analyticsUpdatedAt: optIn === null ? null : at } }; },
    setState: (patch: Partial<CloudProfileState>) => { state = { ...state, ...patch }; } };
}
it('does not send analytics until a saved affirmative choice exists, then omits pre-choice events', async () => {
  const f = fixture();
  await f.sink.send([event]); expect(f.transport).not.toHaveBeenCalled();
  f.decide(false); await f.sink.send([event]); expect(f.transport).not.toHaveBeenCalled();
  f.decide(true); await f.sink.send([{ ...event, at: '2026-11-04T05:59:59Z' }, event]);
  expect(f.transport).toHaveBeenCalledOnce();
  const body = JSON.parse(f.transport.mock.calls[0]![1].body);
  expect(body.batch).toHaveLength(1);
  expect(body.batch[0]).toMatchObject({ event: 'app_document_create', properties: { distinct_id: '$posthog_cookieless', $cookieless_mode: true, $raw_user_agent: 'Browser fixture', $host: 'app.pushform.io', $process_person_profile: false, surface: 'app', shell: 'web' } });
  expect(f.transport.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true });
});
it('stops on withdrawal, sign-out, account switch and unavailable or mismatched profiles', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => f.decide(false),
    (f: ReturnType<typeof fixture>) => f.setOwner(null), (f: ReturnType<typeof fixture>) => f.setOwner('bob'),
    (f: ReturnType<typeof fixture>) => f.setState({ status: 'loading' }),
    (f: ReturnType<typeof fixture>) => f.setState({ ownerId: 'bob' })]) {
    const f = fixture(); f.decide(true); change(f); await f.sink.send([event]); expect(f.transport).not.toHaveBeenCalled();
  }
});
it('honors privacy signals and excludes development, preview and absent configuration', async () => {
  for (const privacy of [{ gpc: true }, { dnt: '1' }, { windowDnt: '1' }]) {
    const f = fixture(); f.decide(true); f.setPrivacy(privacy); await f.sink.send([event]); expect(f.transport).not.toHaveBeenCalled();
  }
  for (const options of [{ production: false }, { hostname: 'preview.pages.dev' }, { token: '' }]) {
    const f = fixture(options); f.decide(true); await f.sink.send([event]); expect(f.transport).not.toHaveBeenCalled();
  }
  const desktop = fixture({ desktop: true, hostname: 'tauri.localhost' }); desktop.decide(true); await desktop.sink.send([event]);
  expect(JSON.parse(desktop.transport.mock.calls[0]![1].body).batch[0].properties.shell).toBe('desktop');
});
it('allows only fixed kinds and properties and groups custom command IDs without exposing them', () => {
  expect(analyticsEvent({ ...event, kind: 'error', category: 'secret' }, 'web', 'UA')).toBeNull();
  const safe = analyticsEvent({ ...event, kind: 'tool_use', tool: 'custom.private-design', count: 99_999, documentName: 'private' } as UsageEvent, 'web', 'UA');
  expect(safe?.properties.tool_group).toBe('other'); expect(safe?.properties.count).toBe(10_000);
  expect(JSON.stringify(safe)).not.toMatch(/private|documentName/);
});
it('analytics transport failures never prevent operational usage and are never retried', async () => {
  const f = fixture(); f.decide(true); f.transport.mockRejectedValue(new Error('offline'));
  await expect(f.sink.send([event])).resolves.toBeUndefined(); expect(f.primary.send).toHaveBeenCalledOnce(); expect(f.transport).toHaveBeenCalledOnce();
});
it('does not duplicate analytics when the operational recorder retries a failed cloud send', async () => {
  const f = fixture(); f.decide(true); f.primary.send.mockRejectedValueOnce(new Error('offline'));
  await expect(f.sink.send([event])).rejects.toThrow('offline');
  await f.sink.send([event]);
  expect(f.primary.send).toHaveBeenCalledTimes(2); expect(f.transport).toHaveBeenCalledOnce();
});
