// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopUpdates, UPDATE_CHECK_INTERVAL, UPDATE_GRACE, allowOpeningDocument, setDesktopUpdates, type UpdateBackend } from './desktopUpdates';

const DAY = 24 * 60 * 60 * 1000;

function memoryStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
}

function setup(options: { enabled?: boolean; latest?: Record<string, string | null> } = {}) {
  let time = Date.parse('2026-10-26T12:00:00Z');
  const latest: Record<string, string | null> = { stable: null, nightly: null, ...options.latest };
  const backend = {
    enabled: vi.fn<UpdateBackend['enabled']>().mockResolvedValue(options.enabled ?? true),
    fetch: vi.fn<UpdateBackend['fetch']>().mockImplementation(async channel => latest[channel] ? { version: latest[channel] } : null),
    install: vi.fn<UpdateBackend['install']>().mockResolvedValue(undefined),
  };
  const store = memoryStore();
  const updates = new DesktopUpdates(backend, store, () => time);
  return { updates, backend, store, latest, advance: (ms: number) => { time += ms; } };
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => { setDesktopUpdates(undefined); vi.useRealTimers(); });

describe('DesktopUpdates', () => {
  it('checks the stable channel at start and every six hours, downloading a newer version in the background', async () => {
    vi.useFakeTimers();
    const { updates, backend, latest } = setup();
    const stop = updates.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.fetch).toHaveBeenCalledExactlyOnceWith('stable');
    expect(updates.getSnapshot()).toMatchObject({ enabled: true, channel: 'stable', ready: null });
    latest.stable = '26.45.3';
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
    expect(backend.fetch).toHaveBeenCalledTimes(2);
    expect(updates.getSnapshot().ready).toBe('26.45.3');
    stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
    expect(backend.fetch).toHaveBeenCalledTimes(2);
  });

  it('never checks in a build without the updater key', async () => {
    const { updates, backend } = setup({ enabled: false, latest: { stable: '26.45.3' } });
    updates.start(); await settle();
    expect(backend.fetch).not.toHaveBeenCalled();
    expect(updates.getSnapshot()).toMatchObject({ enabled: false, ready: null });
    expect(updates.allowOpening()).toBe(true);
  });

  it('keeps failed checks silent and keeps a ready update', async () => {
    const { updates, backend } = setup({ latest: { stable: '26.45.3' } });
    updates.start(); await settle();
    backend.fetch.mockRejectedValueOnce(new Error('offline'));
    await updates.check();
    expect(updates.getSnapshot()).toMatchObject({ ready: '26.45.3', error: null });
  });

  it('hides the notice on Later until a newer version is ready', async () => {
    const { updates, latest } = setup({ latest: { stable: '26.45.3' } });
    updates.start(); await settle();
    updates.dismiss();
    await updates.check();
    expect(updates.getSnapshot().dismissed).toBe(true);
    latest.stable = '26.46.1';
    await updates.check();
    expect(updates.getSnapshot()).toMatchObject({ ready: '26.46.1', dismissed: false });
  });

  it('requires the update before opening a document a week after the first one became ready', async () => {
    const { updates, latest, advance } = setup({ latest: { stable: '26.45.3' } });
    setDesktopUpdates(updates);
    updates.start(); await settle();
    advance(UPDATE_GRACE - 1);
    expect(allowOpeningDocument()).toBe(true);
    // A newer version does not restart the week.
    latest.stable = '26.46.1'; await updates.check();
    advance(1);
    expect(allowOpeningDocument()).toBe(false);
    expect(updates.getSnapshot()).toMatchObject({ required: true, ready: '26.46.1' });
    updates.closeRequired();
    expect(updates.getSnapshot().required).toBe(false);
  });

  it('remembers the week across restarts and starts it again once the app is current', async () => {
    const first = setup({ latest: { stable: '26.45.3' } });
    first.updates.start(); await settle();
    const since = first.store.data.get('pushform.updates.readySince');
    expect(since).toBeDefined();
    const second = new DesktopUpdates(first.backend, first.store, () => Number(since) + 8 * DAY);
    // Nothing is downloaded and ready yet in this run, so nothing is required.
    expect(second.allowOpening()).toBe(true);
    second.start(); await settle();
    expect(second.allowOpening()).toBe(false);
    first.latest.stable = null; await second.check();
    expect(first.store.data.has('pushform.updates.readySince')).toBe(false);
    expect(second.getSnapshot()).toMatchObject({ ready: null, required: false });
    expect(second.allowOpening()).toBe(true);
  });

  it('switches channel at once and remembers it; switching back drops an update the channel does not offer', async () => {
    const { updates, backend, store } = setup({ latest: { nightly: '26.45.9' } });
    updates.start(); await settle();
    await updates.setChannel('nightly');
    expect(backend.fetch).toHaveBeenLastCalledWith('nightly');
    expect(store.data.get('pushform.updates.channel')).toBe('nightly');
    expect(updates.getSnapshot()).toMatchObject({ channel: 'nightly', ready: '26.45.9' });
    expect(new DesktopUpdates(backend, store).getSnapshot().channel).toBe('nightly');
    await updates.setChannel('stable');
    expect(updates.getSnapshot()).toMatchObject({ channel: 'stable', ready: null });
  });

  it('saves every document before installing, and installs nothing when a save fails', async () => {
    const { updates, backend } = setup({ latest: { stable: '26.45.3' } });
    updates.start(); await settle();
    const order: string[] = [];
    backend.install.mockImplementation(async () => { order.push('install'); });
    await updates.install(async () => { order.push('save'); });
    expect(order).toEqual(['save', 'install']);
    // The app restarts; until then a second request does nothing.
    await updates.install(async () => { order.push('save'); });
    expect(order).toEqual(['save', 'install']);
    const failing = setup({ latest: { stable: '26.45.3' } });
    failing.updates.start(); await settle(); failing.updates.dismiss();
    await failing.updates.install(() => Promise.reject(new Error('offline')));
    expect(failing.backend.install).not.toHaveBeenCalled();
    expect(failing.updates.getSnapshot()).toMatchObject({ installing: false, dismissed: false });
    expect(failing.updates.getSnapshot().error).toMatch(/waits until your changes are saved/);
  });

  it('reports an install failure so the user can try again', async () => {
    const { updates, backend } = setup({ latest: { stable: '26.45.3' } });
    updates.start(); await settle();
    backend.install.mockRejectedValueOnce(new Error('signature mismatch'));
    await updates.install(async () => {});
    expect(updates.getSnapshot()).toMatchObject({ installing: false, error: 'The update could not be installed: signature mismatch' });
  });

  it('is absent in the browser, which never blocks opening documents', () => {
    expect(allowOpeningDocument()).toBe(true);
  });
});
