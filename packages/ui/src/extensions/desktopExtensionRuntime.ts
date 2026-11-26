// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { ExtensionError } from '@pushform/extension-protocol';
import { startNativeRuntime } from '@pushform/extensions';
import type { NativeTransport } from '@pushform/extensions';
import type { NativeWireFrame } from '@pushform/extensions';
import type { ExtensionRuntimeSources } from './browserExtensionPlatform';
interface Output { runtime: string; sequence: number; frame: string }
async function nativeTransport(source: string): Promise<NativeTransport> {
  let id: string | null = null, ended = false, handler: ((frame: NativeWireFrame) => void) | null = null;
  const queued: Output[] = [];
  let queuedBytes = 0;
  const stop = (): void => {
    if (ended) return; ended = true; queued.length = 0;
    if (id) void invoke('extensions_runtime_stop', { runtime: id }).catch(() => {});
  };
  const deliver = (message: Output): void => {
    if (ended) return;
    if (!id || message.runtime !== id || !Number.isSafeInteger(message.sequence) || message.sequence < 1 || typeof message.frame !== 'string') { stop(); return; }
    try { handler?.(JSON.parse(message.frame) as NativeWireFrame); }
    catch { stop(); return; }
    void invoke('extensions_runtime_ack', { runtime: id, sequence: message.sequence }).catch(stop);
  };
  const channel = new Channel<Output>();
  channel.onmessage = message => {
    if (ended) return;
    if (!id || !handler) {
      if (typeof message.frame !== 'string' || queued.length >= 16 || queuedBytes + message.frame.length * 2 > 8 * 1024 * 1024) { stop(); return; }
      queued.push(message); queuedBytes += message.frame.length * 2; return;
    }
    deliver(message);
  };
  try { id = await invoke<string>('extensions_runtime_start', { source, output: channel }); }
  catch (cause) { stop(); throw new ExtensionError('extension.failed', typeof cause === 'string' ? cause : 'The native runtime could not start.'); }
  if (ended) { void invoke('extensions_runtime_stop', { runtime: id }).catch(() => {}); throw new ExtensionError('extension.failed', 'Native startup output exceeded its limits.'); }
  return {
    post: frame => {
      if (ended) return Promise.reject(new ExtensionError('cancelled', 'The native runtime stopped.'));
      return invoke('extensions_runtime_post', { runtime: id, frame });
    },
    stop,
    listen: listener => {
      handler = listener;
      for (const message of queued.splice(0)) deliver(message); queuedBytes = 0;
      return () => { if (handler === listener) handler = null; };
    },
  };
}
/** Native engine availability is decided by the shell; a missing helper never enables the browser iframe path. */
export async function desktopExtensionRuntime(sources: ExtensionRuntimeSources & { nativeHostSource: string }): Promise<ExtensionRuntimeSources | undefined> {
  if (!isTauri() || !await invoke<boolean>('extensions_runtime_supported').catch(() => false)) return undefined;
  return { ...sources, startRuntime: async record => startNativeRuntime({
    files: new Map(Object.entries(record.files)), main: record.manifest.main,
    workerSource: sources.workerSource, ...(record.manifest.wasm.length ? { computeSource: sources.computeSource } : {}),
    transport: await nativeTransport(sources.nativeHostSource),
  }) };
}
