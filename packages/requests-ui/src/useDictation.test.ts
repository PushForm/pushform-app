// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDictation } from './useDictation';

class Recognition {
  static instances: Recognition[] = [];
  continuous = false;
  interimResults = false;
  lang = '';
  onresult = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
  constructor() { Recognition.instances.push(this); }
}

const getUserMedia = vi.fn();
beforeEach(() => {
  Recognition.instances = [];
  getUserMedia.mockReset();
  vi.stubGlobal('webkitSpeechRecognition', Recognition);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true, value: { getUserMedia },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('dictation microphone permission', () => {
  it('requests audio before recognition and releases the permission stream', async () => {
    let allow!: (stream: unknown) => void;
    getUserMedia.mockReturnValue(new Promise(resolve => { allow = resolve; }));
    const release = vi.fn();
    const { result } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.toggle());
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(Recognition.instances).toHaveLength(0);
    await act(async () => { allow({ getTracks: () => [{ stop: release }] }); });
    expect(release).toHaveBeenCalledOnce();
    expect(Recognition.instances[0]!.start).toHaveBeenCalledOnce();
    expect(result.current.listening).toBe(true);
  });

  it.each(['stop', 'unmount'] as const)('does not start after %s while permission is pending', async action => {
    let allow!: (stream: unknown) => void;
    getUserMedia.mockReturnValue(new Promise(resolve => { allow = resolve; }));
    const release = vi.fn();
    const { result, unmount } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.toggle());
    if (action === 'unmount') unmount();
    else act(() => result.current.toggle());
    await act(async () => { allow({ getTracks: () => [{ stop: release }] }); });
    expect(release).toHaveBeenCalledOnce();
    expect(Recognition.instances).toHaveLength(0);
  });

  it('reports denied access without starting recognition and allows retry', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    const { result } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.error).toContain('Microphone access was blocked'));
    expect(result.current.listening).toBe(false);
    expect(Recognition.instances).toHaveLength(0);
    getUserMedia.mockResolvedValue({ getTracks: () => [] });
    await act(async () => result.current.toggle());
    expect(Recognition.instances[0]!.start).toHaveBeenCalledOnce();
    expect(result.current.error).toBeNull();
  });

  it('distinguishes a blocked speech service from microphone denial', async () => {
    getUserMedia.mockResolvedValue({ getTracks: () => [] });
    const { result } = renderHook(() => useDictation(vi.fn()));
    await act(async () => result.current.toggle());
    act(() => Recognition.instances[0]!.onerror?.({ error: 'service-not-allowed' }));
    expect(result.current.error).toContain('Speech recognition is unavailable or blocked');
  });
});
