// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * Closes what the runtime's content security policy leaves open. The policy has to allow `blob:` scripts and
 * workers, because the bootstrap itself runs the package from blob URLs; left alone, extension code could make blob
 * URLs of its own and import them (running code it received as data, for example over the network broker), or start
 * nested workers. It must also allow compiling WebAssembly for packages that declare compute modules, which run in
 * separate compute workers; extension code itself must not compile any. The bootstrap therefore removes the ways to
 * make blob URLs, workers and WebAssembly modules before any extension code
 * runs. The replacements are non-configurable, so they cannot be deleted or redefined afterwards, and a worker has no
 * other realm from which a fresh copy could be taken.
 */
export function lockDownRuntime(scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  const seal = (target: object, key: string): void => {
    Object.defineProperty(target, key, { value: undefined, writable: false, enumerable: false, configurable: false });
  };
  for (const name of ['URL', 'webkitURL']) {
    const ctor = scope[name] as Record<string, unknown> | undefined;
    if (ctor && 'createObjectURL' in ctor) seal(ctor, 'createObjectURL');
  }
  // `importScripts` is defined on WorkerGlobalScope.prototype, so it is sealed wherever the prototype chain holds it.
  for (const name of ['Worker', 'SharedWorker', 'importScripts', 'WebAssembly']) {
    if (!(name in scope)) continue;
    for (let target: object | null = scope; target; target = Object.getPrototypeOf(target))
      if (Object.hasOwn(target, name)) seal(target, name);
    if (!Object.hasOwn(scope, name)) seal(scope, name);
  }
}
