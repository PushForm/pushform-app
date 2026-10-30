// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { startGuest } from '../guest';
import { messagePortTransport } from '../port';
import { linkModules } from './link';
import { lockDownRuntime } from './lockdown';

/**
 * Entry of an extension's worker, bundled as one classic script (Chromium does not start module workers from blob
 * URLs in a sandboxed frame). It accepts exactly one `init` message from the frame bootstrap, carrying the verified
 * package files, the entry path and the protocol port. It links the package's modules to blob URLs, locks the
 * runtime down so no further code can be made, and only then imports the entry module and runs the lifecycle.
 */

interface InitMessage {
  readonly type: 'init';
  readonly main: string;
  readonly files: Readonly<Record<string, ArrayBuffer>>;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

function onInit(event: MessageEvent): void {
  const data = event.data as Partial<InitMessage> | null;
  const port = event.ports[0];
  if (data?.type !== 'init' || typeof data.main !== 'string' || !data.files || !port) return;
  scope.removeEventListener('message', onInit);
  const files = new Map(Object.entries(data.files).map(([path, buffer]) => [path, new Uint8Array(buffer)] as const));
  const main = data.main;
  void startGuest(messagePortTransport(port), async () => {
    const mainUrl = await linkModules(files, main, (_path, source) => URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    files.clear();
    lockDownRuntime();
    return import(/* @vite-ignore */ mainUrl);
  });
}

scope.addEventListener('message', onInit);
