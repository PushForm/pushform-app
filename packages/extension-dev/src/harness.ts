// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  extensionManifestSchema, type ExtensionManifest, type ExtensionManifestInput, type ExtensionPermission, type UiEvent, type UiNode,
} from '@pushform/extension-protocol';
import {
  ComputeHost, ExtensionSession, ExtensionSettingsHost, ExtensionUiHost, FetchBroker, clipboardServices, fileServices, memorySettingsStore, vectorExportServices,
  messagePortTransport, runComputeWorker, startGuest, type FetchTransport, type FilePicker, type InvokeOptions, type ServiceImplementations,
  type SettingsStore, type SpawnComputeWorker,
} from '@pushform/extensions';

/**
 * A test host for an extension: its real entry module runs through the same lifecycle, message validation,
 * permission checks and interface, settings, compute, file, clipboard and network hosts as in PushForm, connected
 * over a MessageChannel in the same process. What the isolated runtime adds in the app (its sandbox, content
 * security policy and lockdown) is not reproduced here. Host services the harness does not provide, such as the
 * model, can be supplied as fakes through `services`.
 */

export interface TestHostOptions {
  /** The manifest, as in `manifest.json`; the `files` list may be left out. */
  readonly manifest: Omit<ExtensionManifestInput, 'files'> & { files?: Record<string, string> };
  /** The entry module, as imported by the test (`await import('./dist/main.js')`). */
  readonly module: unknown;
  /** Permissions granted; all the manifest requests by default. */
  readonly grants?: readonly ExtensionPermission[];
  /** Package files, needed for WebAssembly modules. */
  readonly files?: ReadonlyMap<string, Uint8Array>;
  /** Further host services, or replacements, keyed `service.method`. */
  readonly services?: ServiceImplementations;
  readonly settings?: SettingsStore;
  /** Answers file prompts; by default every prompt is declined. */
  readonly picker?: FilePicker;
  /** Performs network requests that pass the broker's checks; by default requests answer unavailable. */
  readonly fetch?: FetchTransport;
}

export interface TestHost {
  readonly manifest: ExtensionManifest;
  readonly session: ExtensionSession;
  readonly ui: ExtensionUiHost;
  /** Lines the extension wrote with `context.log.write`. */
  readonly logs: unknown[];
  /** What the extension wrote to the clipboard. */
  readonly clipboard: { text?: string; html?: string; png?: Uint8Array }[];
  /** Runs a contribution, as a user-started action by default. */
  invoke(contributionId: string, params?: unknown, options?: InvokeOptions): Promise<unknown>;
  /** The tree the extension shows for a target, if any. */
  tree(target: string): UiNode | undefined;
  /** Sends user input on a mounted interface; false when it does not fit the tree shown. */
  dispatch(target: string, event: UiEvent): boolean;
  /** Presses a button. */
  press(target: string, component: string): boolean;
  /** Stops the extension, running its deactivate. */
  close(): Promise<void>;
}

/** Compute workers in this process. Fine for tests; a module that never returns blocks the test. */
const inProcessCompute: SpawnComputeWorker = async () => {
  const channel = new MessageChannel();
  runComputeWorker({
    post: (message, transfer) => channel.port2.postMessage(message, transfer ?? []),
    listen: (handler) => { channel.port2.onmessage = (e) => handler(e.data); },
  });
  return {
    post: (message, transfer) => channel.port1.postMessage(message, transfer ?? []),
    listen: (handler) => { channel.port1.onmessage = (e) => handler(e.data); },
    terminate: () => { channel.port1.close(); channel.port2.close(); },
  };
};

const declining: FilePicker = { open: async () => null, save: async () => null };

export async function createTestHost(options: TestHostOptions): Promise<TestHost> {
  const manifest = extensionManifestSchema.parse({ ...options.manifest, files: options.manifest.files ?? {} });
  const grants = new Set(options.grants ?? manifest.permissions);
  const channel = new MessageChannel();
  const logs: unknown[] = [];
  const clipboard: TestHost['clipboard'] = [];
  const ref: { session?: ExtensionSession } = {};
  const ui = new ExtensionUiHost(manifest, (event) => ref.session?.postEvent(event));
  const settings = new ExtensionSettingsHost(manifest, options.settings ?? memorySettingsStore());
  const compute = manifest.wasm.length ? new ComputeHost({ manifest, files: options.files ?? new Map(), spawn: inProcessCompute }) : null;
  const services: ServiceImplementations = {
    ...ui.services(),
    ...settings.services(),
    ...(compute?.services() ?? {}),
    ...fileServices(manifest, options.picker ?? declining),
    ...vectorExportServices(manifest, () => ui, options.picker ?? declining),
    ...clipboardServices({ write: async (items) => { clipboard.push(items); } }),
    ...new FetchBroker(manifest, grants, options.fetch ?? null).services(),
    'log.write': (input) => { logs.push(input); return null; },
    ...options.services,
  };
  const session = ref.session = new ExtensionSession({
    manifest, grants, port: messagePortTransport(channel.port1), services, beforeActivate: () => settings.prepare(),
  });
  void startGuest(messagePortTransport(channel.port2), async () => options.module);
  return {
    manifest, session, ui, logs, clipboard,
    invoke: (id, params = {}, invokeOptions = {}) => session.invoke(id, params, { userAction: true, ...invokeOptions }),
    tree: (target) => ui.get(target)?.tree,
    dispatch: (target, event) => ui.dispatch(target, event),
    press: (target, component) => ui.dispatch(target, { component, event: 'press' }),
    async close() {
      await session.deactivate('shutdown');
      compute?.terminateAll();
      channel.port1.close();
      channel.port2.close();
    },
  };
}
