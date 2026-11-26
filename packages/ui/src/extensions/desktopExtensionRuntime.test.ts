// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ isTauri: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ ...api, Channel: class {} }));
import { desktopExtensionRuntime } from './desktopExtensionRuntime';
const sources = { workerSource: 'worker', computeSource: 'compute', nativeHostSource: 'trusted host' };
beforeEach(() => { vi.clearAllMocks(); });
it('does not start or probe a native runtime in a browser', async () => {
  api.isTauri.mockReturnValue(false);
  expect(await desktopExtensionRuntime(sources)).toBeUndefined(); expect(api.invoke).not.toHaveBeenCalled();
});
it('leaves unsupported or unavailable native engines disabled', async () => {
  api.isTauri.mockReturnValue(true); api.invoke.mockResolvedValueOnce(false).mockRejectedValueOnce(Error('Missing native support'));
  expect(await desktopExtensionRuntime(sources)).toBeUndefined(); expect(await desktopExtensionRuntime(sources)).toBeUndefined();
  expect(api.invoke.mock.calls.map(call => call[0])).toEqual(['extensions_runtime_supported', 'extensions_runtime_supported']);
});
it('selects the supported native factory while leaving execution lazy', async () => {
  api.isTauri.mockReturnValue(true); api.invoke.mockResolvedValueOnce(true);
  const runtime = await desktopExtensionRuntime(sources);
  expect(runtime?.startRuntime).toBeTypeOf('function'); expect(runtime?.workerSource).toBe('worker');
  expect(api.invoke).toHaveBeenCalledTimes(1); expect(api.invoke).toHaveBeenCalledWith('extensions_runtime_supported');
});
