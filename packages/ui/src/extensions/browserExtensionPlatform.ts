// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionPlatform, localSettingsStore, startWebRuntime, storedDeveloperMode, type SessionFailure, type InstalledExtension } from '@pushform/extensions';
import { browserClipboardWriter, browserFilePicker } from './browserExtensionIo';
import { browserViewPrinter, type PrintPrompts } from './extensionPrint';
import { indexedDbExtensionStore } from './indexedDbExtensionStore';

/** The extension runtime's two worker bootstraps, bundled as classic scripts by the web build. */
export interface ExtensionRuntimeSources {
  readonly workerSource: string;
  readonly computeSource: string;
}

/**
 * Whether this browser can run the isolated extension runtime. WebKit refuses the runtime's workers while the page is
 * cross-origin isolated, as PushForm's is, so Safari is excluded.
 */
export function browserRunsExtensions(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return !/AppleWebKit/.test(userAgent) || /Chrome\/|Chromium\/|Edg\//.test(userAgent);
}

/** The extension platform of a signed-in account in this browser. */
export function createBrowserExtensionPlatform(options: {
  readonly ownerId: string;
  readonly sources: ExtensionRuntimeSources;
  readonly storage?: Storage;
  /** False where organization policy forbids developer mode. */
  readonly developerModeAllowed?: () => boolean;
  readonly onFailure?: (record: InstalledExtension, failure: SessionFailure) => void;
  /** Where print requests wait for the user; without it extensions cannot print. */
  readonly printPrompts?: PrintPrompts;
}): ExtensionPlatform {
  const storage = options.storage ?? window.localStorage;
  return new ExtensionPlatform({
    store: indexedDbExtensionStore(options.ownerId),
    developerMode: storedDeveloperMode(storage, options.developerModeAllowed),
    startRuntime: (record) => startWebRuntime({
      files: new Map(Object.entries(record.files)), main: record.manifest.main, wasm: record.manifest.wasm.length > 0,
      workerSource: options.sources.workerSource, computeSource: options.sources.computeSource,
    }),
    // Settings stay on this device until official extensions, which sync them with the account, can be installed.
    settingsStore: () => localSettingsStore(storage, options.ownerId),
    // The browser's own confirmation, never the extension's interface, names the extension and its purpose; the
    // click on it is also the gesture the file picker needs.
    filePicker: browserFilePicker(async (request) => window.confirm(`${request.extensionName} wants to ${request.kind === 'open' ? 'open' : 'save'} a file: ${request.purpose}\n\nChoose the file?`)),
    clipboard: browserClipboardWriter(),
    fetchTransport: null,
    ...(options.printPrompts ? { printer: browserViewPrinter(options.printPrompts) } : {}),
    ...(options.onFailure ? { onFailure: options.onFailure } : {}),
  });
}
