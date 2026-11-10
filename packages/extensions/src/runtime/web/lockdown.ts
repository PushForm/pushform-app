// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * Closes what the runtime's content security policy leaves open. The policy has to allow `blob:` scripts and
 * workers, because the bootstrap itself runs the package from blob URLs; left alone, extension code could make blob
 * URLs of its own and import them (running code it received as data, for example over the network broker), or start
 * nested workers. It must also allow compiling WebAssembly for packages that declare compute modules, which run in
 * separate compute workers; extension code itself must not compile any. The bootstrap therefore removes the ways to
 * make blob URLs, workers and WebAssembly modules, and direct persistent storage, before any extension code
 * runs. The replacements are non-configurable, so they cannot be deleted or redefined afterwards, and a worker has no
 * other realm from which a fresh copy could be taken.
 */
export function lockDownRuntime(scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  const seal = (target: object, key: string): void => {
    Object.defineProperty(target, key, { value: undefined, writable: false, enumerable: false, configurable: false });
  };
  const sealInherited = (target: object, name: string): void => {
    for (let current: object | null = target; current; current = Object.getPrototypeOf(current))
      if (Object.hasOwn(current, name)) seal(current, name);
    if (!Object.hasOwn(target, name)) seal(target, name);
  };
  for (const name of ['URL', 'webkitURL']) {
    const ctor = scope[name] as Record<string, unknown> | undefined;
    if (ctor && 'createObjectURL' in ctor) seal(ctor, 'createObjectURL');
  }
  // `importScripts` is defined on WorkerGlobalScope.prototype, so it is sealed wherever the prototype chain holds it.
  for (const name of ['Worker', 'SharedWorker', 'importScripts', 'WebAssembly', 'indexedDB', 'caches', 'cookieStore', 'BroadcastChannel']) {
    if (!(name in scope)) continue;
    sealInherited(scope, name);
  }
  // Named native origins have working storage APIs; do not rely on an opaque browser origin refusing them.
  const navigator = scope.navigator;
  if (navigator && typeof navigator === 'object')
    for (const name of ['storage', 'storageBuckets', 'serviceWorker'])
      if (name in navigator) sealInherited(navigator, name);
}
