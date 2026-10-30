// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Only the dependency-free core: this file runs inside every extension runtime, where size matters.
import {
  EXTENSION_SERVICES, ExtensionError, RUNTIME_PROTOCOL_VERSION, isHostMessage, methodPermission, serviceAvailable,
  servicePermissions, type ExtensionErrorData, type ExtensionServiceName, type ServiceAccess,
} from '@pushform/extension-protocol/runtime-core';
import type { ExtensionPermission, HostMessage } from '@pushform/extension-protocol';
import type { RuntimePort } from './port';

/**
 * The extension side of the lifecycle, run by the host's bootstrap inside the extension's isolated runtime. It
 * imports the package's single entry module, then waits. On `activate` it calls the module's `activate(context)`
 * with a `context` that holds only the services the grants allow; on `invoke` it runs the handler the extension
 * registered for that contribution; on `deactivate` it aborts everything in flight and calls `deactivate()`.
 * This file is host code: extensions never bundle it, they only receive the `context` it builds.
 */

export interface CallOptions {
  readonly signal?: AbortSignal;
}

/** Passed to every contribution handler with its parameters. */
export interface InvocationContext {
  /** Aborted when the user cancels, the panel or document closes, or the extension is disabled or updated. */
  readonly signal: AbortSignal;
}

export type ContributionHandler = (params: unknown, invocation: InvocationContext) => unknown;

type ServiceProxy = Readonly<Record<string, (input?: unknown, options?: CallOptions) => Promise<unknown>>>;

/** The object an extension's `activate` receives. Only granted services are present. */
export interface ExtensionContext {
  readonly extensionId: string;
  readonly commands: { register(contributionId: string, handler: ContributionHandler): void };
  /** Aborted when the extension is deactivated. */
  readonly signal: AbortSignal;
  readonly [service: string]: unknown;
}

interface EntryModule {
  activate(context: ExtensionContext): unknown;
  deactivate?(): unknown;
}

const errorData = (error: unknown): ExtensionErrorData => {
  if (error instanceof ExtensionError) return error.toJSON();
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'The extension failed.';
  return { code: 'extension.failed', message: message.slice(0, 500) };
};

const cancelled = (): ExtensionError => new ExtensionError('cancelled', 'The operation was cancelled.');

/**
 * Runs the lifecycle over `port`. `loadMain` imports the entry module; in the isolated runtime it is a dynamic
 * import of the verified `main` file, in tests a module object.
 */
export async function startGuest(port: RuntimePort, loadMain: () => Promise<unknown>): Promise<void> {
  let entry: EntryModule;
  try {
    const module = await loadMain() as Partial<EntryModule> | null;
    if (!module || typeof module.activate !== 'function')
      throw new ExtensionError('validation.failed', 'The entry module does not export an activate function.');
    if (module.deactivate !== undefined && typeof module.deactivate !== 'function')
      throw new ExtensionError('validation.failed', 'The entry module exports deactivate, but it is not a function.');
    entry = module as EntryModule;
  } catch (error) {
    port.post({ type: 'load-failed', error: errorData(error) });
    return;
  }

  let nextRequest = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const handlers = new Map<string, ContributionHandler>();
  const invocations = new Map<number, AbortController>();
  const lifetime = new AbortController();
  let contributions = new Set<string>();
  let state: 'loaded' | 'activating' | 'active' | 'stopped' = 'loaded';

  const request = (service: string, method: string, input: unknown, options: CallOptions = {}): Promise<unknown> => {
    const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
    if (signal.aborted) return Promise.reject(cancelled());
    const id = nextRequest++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!pending.delete(id)) return;
        port.post({ type: 'cancel-request', id });
        reject(cancelled());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
        reject: (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      });
      port.post({ type: 'request', id, service, method, input });
    });
  };

  const buildContext = (extensionId: string, access: ServiceAccess): ExtensionContext => {
    const context: Record<string, unknown> = {
      extensionId,
      signal: lifetime.signal,
      commands: Object.freeze({
        register(contributionId: string, handler: ContributionHandler) {
          if (!contributions.has(contributionId))
            throw new ExtensionError('validation.failed', `"${contributionId}" is not a contribution in the manifest.`);
          if (typeof handler !== 'function') throw new ExtensionError('validation.failed', 'A handler must be a function.');
          handlers.set(contributionId, handler);
        },
      }),
    };
    for (const service of Object.keys(EXTENSION_SERVICES) as ExtensionServiceName[]) {
      if (!serviceAvailable(service, access)) continue;
      const methods: Record<string, (input?: unknown, options?: CallOptions) => Promise<unknown>> = {};
      for (const method of Object.keys(EXTENSION_SERVICES[service])) {
        const permission = methodPermission(service, method) as ExtensionPermission | null;
        methods[method] = (input, options) => permission !== null && !access.grants.has(permission)
          ? Promise.reject(new ExtensionError('permission.denied', `${service}.${method} needs the ${permission} permission.`, { permission }))
          : request(service, method, input, options);
      }
      context[service] = Object.freeze(methods) satisfies ServiceProxy;
    }
    // Reading a service that was not granted fails loudly with the permission to request, instead of `undefined`.
    return new Proxy(Object.freeze(context), {
      get(target, key, receiver) {
        if (typeof key === 'string' && !(key in target) && Object.hasOwn(EXTENSION_SERVICES, key)) {
          const service = key as ExtensionServiceName;
          const needed = servicePermissions(service);
          throw needed.length
            ? new ExtensionError('permission.denied', `context.${service} needs one of: ${needed.join(', ')}.`, { permissions: needed })
            : new ExtensionError('unavailable', `context.${service} needs a WASM module declared in the manifest.`);
        }
        return Reflect.get(target, key, receiver);
      },
    }) as ExtensionContext;
  };

  const runInvocation = (message: Extract<HostMessage, { type: 'invoke' }>): void => {
    const handler = handlers.get(message.contribution);
    if (state !== 'active' || !handler) {
      port.post({ type: 'result', invocation: message.invocation, ok: false,
        error: { code: 'unavailable', message: `No handler is registered for "${message.contribution}".` } });
      return;
    }
    const controller = new AbortController();
    invocations.set(message.invocation, controller);
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    Promise.resolve()
      .then(() => handler(message.params, Object.freeze({ signal })))
      .then(
        (value) => ({ type: 'result', invocation: message.invocation, ok: true, value: value ?? null }),
        (error: unknown) => ({ type: 'result', invocation: message.invocation, ok: false,
          error: signal.aborted ? cancelled().toJSON() : errorData(error) }),
      )
      .then((result) => {
        invocations.delete(message.invocation);
        try {
          port.post(result);
        } catch {
          port.post({ type: 'result', invocation: message.invocation, ok: false,
            error: { code: 'validation.failed', message: 'The handler returned a value that cannot be sent to the host.' } });
        }
      });
  };

  const stop = async (): Promise<void> => {
    state = 'stopped';
    lifetime.abort();
    for (const controller of invocations.values()) controller.abort();
    for (const { reject } of pending.values()) reject(cancelled());
    pending.clear();
    try {
      await entry.deactivate?.();
    } finally {
      port.post({ type: 'deactivated' });
      unlisten();
    }
  };

  const unlisten = port.listen((raw) => {
    if (!isHostMessage(raw)) return;
    const message = raw as unknown as HostMessage;
    switch (message.type) {
      case 'activate': {
        if (state !== 'loaded') return;
        state = 'activating';
        contributions = new Set(message.contributions);
        const context = buildContext(message.extensionId, { grants: new Set(message.grants), wasm: message.wasm });
        Promise.resolve()
          .then(() => entry.activate(context))
          .then(() => { state = 'active'; port.post({ type: 'activated' }); },
            (error: unknown) => { state = 'stopped'; port.post({ type: 'activation-failed', error: errorData(error) }); });
        return;
      }
      case 'invoke':
        runInvocation(message);
        return;
      case 'cancel':
        invocations.get(message.invocation)?.abort();
        return;
      case 'response': {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.ok) waiter.resolve(message.result);
        else waiter.reject(ExtensionError.from(message.error));
        return;
      }
      case 'deactivate':
        if (state !== 'stopped') void stop().catch(() => {});
        return;
    }
  });
  port.post({ type: 'ready', v: RUNTIME_PROTOCOL_VERSION });
}
