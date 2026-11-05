// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { EdgeCache } from './render';

/** The Workers edge cache, when the runtime has one. Entries are keyed by a synthetic GET request. */
export function workerCache(): EdgeCache | null {
  const store = (globalThis as { caches?: { default?: { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void> } } }).caches?.default;
  return store ? { match: key => store.match(new Request(key)), put: (key, response) => store.put(new Request(key), response) } : null;
}
