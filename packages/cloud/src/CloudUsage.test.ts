// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import { CloudUsage, CloudUsageError } from './CloudUsage';

const signedIn = { getSnapshot: () => ({ status: 'signedIn' }) } as never;
const client = (error: { message: string } | null = null) => ({ rpc: vi.fn().mockResolvedValue({ data: error ? null : 2, error, status: error ? 400 : 200 }) });

describe('CloudUsage', () => {
  it('sends events through app_record_events with only the fields that are set', async () => {
    const rpc = client();
    await new CloudUsage(rpc as never, signedIn).send([
      { kind: 'session_start', at: '2026-10-27T12:00:00.000Z', appVersion: '0.9.1', appBuild: 'abc' },
      { kind: 'tool_use', tool: 'tool.line', count: 3, documentType: 'model', at: '2026-10-27T12:00:00.000Z' },
      { kind: 'document_close', documentType: 'layout', durationSeconds: 0, at: '2026-10-27T12:00:01.000Z' },
    ]);
    expect(rpc.rpc).toHaveBeenCalledWith('app_record_events', { p_events: [
      { kind: 'session_start', client_at: '2026-10-27T12:00:00.000Z', app_version: '0.9.1', app_build: 'abc' },
      { kind: 'tool_use', client_at: '2026-10-27T12:00:00.000Z', document_type: 'model', tool: 'tool.line', count: 3 },
      { kind: 'document_close', client_at: '2026-10-27T12:00:01.000Z', document_type: 'layout', duration_seconds: 0 },
    ] });
  });
  it('sends nothing when signed out or empty, and maps refusals to error codes', async () => {
    const rpc = client();
    await expect(new CloudUsage(rpc as never, { getSnapshot: () => ({ status: 'signedOut' }) } as never).send([{ kind: 'home_view', at: 't' }])).rejects.toMatchObject({ code: 'auth' });
    await new CloudUsage(rpc as never, signedIn).send([]);
    expect(rpc.rpc).not.toHaveBeenCalled();
    for (const [message, code] of [['cloud_invalid', 'invalid'], ['cloud_rate_limited', 'rate_limited'], ['cloud_auth', 'auth'], ['boom', 'unavailable']] as const) {
      const failed = new CloudUsage(client({ message }) as never, signedIn).send([{ kind: 'home_view', at: 't' }]);
      await expect(failed).rejects.toBeInstanceOf(CloudUsageError);
      await expect(failed).rejects.toMatchObject({ code });
    }
  });
  it('stops asking an installation that has no app_record_events yet', async () => {
    const rpc = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 }) };
    const usage = new CloudUsage(rpc as never, signedIn);
    await usage.send([{ kind: 'home_view', at: 't' }]);
    await usage.send([{ kind: 'home_view', at: 't' }]);
    expect(rpc.rpc).toHaveBeenCalledTimes(1);
  });
});
