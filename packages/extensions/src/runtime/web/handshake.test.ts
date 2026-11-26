// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionError } from '@pushform/extension-protocol';
import { startWebRuntime, type WebRuntime } from './webRuntime';

/**
 * The editor's side of the runtime handshake. jsdom runs no frame scripts, so each test plays the frame: it reads the
 * `load` the editor sent to the frame, and answers (or forges answers) with window messages of its own.
 */

const opened: MessageChannel[] = [];
afterEach(() => {
  for (const c of opened.splice(0)) { c.port1.close(); c.port2.close(); }
  document.body.replaceChildren();
});

const ports = (count: number): MessagePort[] => Array.from({ length: count }, () => {
  const channel = new MessageChannel();
  opened.push(channel);
  return channel.port2;
});

/** Starts a runtime and returns the frame, the `load` it was sent, and the pending start. */
async function begin(handshakeMs = 300) {
  const starting = startWebRuntime({ files: new Map([['main.js', new Uint8Array([1, 2])]]), main: 'main.js', wasm: false, workerSource: 'worker', handshakeMs });
  starting.catch(() => {});
  const frame = [...document.querySelectorAll('iframe')].at(-1)!;
  const sent = await new Promise<{ type: string; nonce: string; files: Record<string, ArrayBuffer> }>((resolve) => {
    frame.contentWindow!.postMessage = ((message: never) => resolve(message)) as never;
  });
  return { frame, sent, starting };
}

const answer = (source: Window | null, data: unknown, count = 2) =>
  window.dispatchEvent(new MessageEvent('message', { data, source, ports: ports(count) }));

const settled = <T>(promise: Promise<T>, ms = 50): Promise<T | 'pending'> =>
  Promise.race([promise, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);

describe('runtime frame', () => {
  it('is hidden, sandboxed with allow-scripts only, sends no referrer and carries its own policy', async () => {
    const { frame } = await begin();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.style.display).toBe('none');
    expect(frame.srcdoc).toContain(`http-equiv="Content-Security-Policy" content="default-src 'none'`);
  });

  it('is sent the package files once, with a fresh nonce per runtime', async () => {
    const first = await begin();
    const second = await begin();
    expect(first.sent).toMatchObject({ type: 'load', main: 'main.js', worker: 'worker' });
    expect(Object.keys(first.sent.files)).toEqual(['main.js']);
    expect(first.sent.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.sent.nonce).not.toBe(first.sent.nonce);
  });
});

describe('handshake', () => {
  it('accepts only its own frame\'s answer, with its nonce and both ports', async () => {
    const { frame, sent, starting } = await begin();
    const other = document.body.appendChild(document.createElement('iframe'));
    answer(other.contentWindow, { type: 'ready', nonce: sent.nonce }); // another window, right nonce
    answer(window, { type: 'ready', nonce: sent.nonce }); // the editor itself
    answer(null, { type: 'ready', nonce: sent.nonce }); // no source
    answer(frame.contentWindow, { type: 'ready', nonce: 'guessed' }); // its frame, wrong nonce
    answer(frame.contentWindow, { type: 'ready', nonce: sent.nonce }, 1); // one port short
    answer(frame.contentWindow, { type: 'ready', nonce: sent.nonce }, 3); // one port too many
    answer(frame.contentWindow, { type: 'loaded', nonce: sent.nonce }); // another type
    expect(await settled(starting)).toBe('pending');
    answer(frame.contentWindow, { type: 'ready', nonce: sent.nonce });
    const runtime = await settled(starting) as WebRuntime;
    expect(runtime).not.toBe('pending');
    runtime.terminate();
  });

  it('stops listening once it has its answer, so a later forged answer changes nothing', async () => {
    const { frame, sent, starting } = await begin();
    answer(frame.contentWindow, { type: 'ready', nonce: sent.nonce });
    const runtime = await starting;
    const posted: unknown[] = [];
    runtime.port.listen((m) => posted.push(m));
    answer(frame.contentWindow, { type: 'ready', nonce: sent.nonce });
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toEqual([]);
    runtime.terminate();
  });

  it('gives up when no valid answer comes, removing the frame and reporting the browser as unsupported', async () => {
    const { frame, sent, starting } = await begin(60);
    answer(frame.contentWindow, { type: 'ready', nonce: `${sent.nonce}x` });
    const error = await starting.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ExtensionError);
    expect((error as ExtensionError).code).toBe('extension.unsupported');
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
  });

  it('ends the runtime by removing the frame, and terminating twice is harmless', async () => {
    const { frame, sent, starting } = await begin();
    answer(frame.contentWindow, { type: 'ready', nonce: sent.nonce });
    const runtime = await starting;
    runtime.terminate();
    runtime.terminate();
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    await expect(runtime.startCompute()).rejects.toMatchObject({ code: 'unavailable' });
  });
});
