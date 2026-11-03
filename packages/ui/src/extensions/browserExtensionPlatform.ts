// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  ExtensionPlatform, localSettingsStore, startWebRuntime, storedDeveloperMode, type ExtensionDocuments, type ExtensionFailure, type InstalledExtension,
  type UiOpenRequest,
} from '@pushform/extensions';
import type { UnitSettings } from '@pushform/core';
import { browserClipboardWriter, browserFilePicker } from './browserExtensionIo';
import { browserViewPrinter, type PrintPrompts } from './extensionPrint';
import { indexedDbActivityStore, indexedDbExtensionStore } from './indexedDbExtensionStore';

export { browserRunsExtensions } from './browserRunsExtensions';

/** The extension runtime's two worker bootstraps, bundled as classic scripts by the web build. */
export interface ExtensionRuntimeSources {
  readonly workerSource: string;
  readonly computeSource: string;
}

/** The extension platform of a signed-in account in this browser. */
export function createBrowserExtensionPlatform(options: {
  readonly ownerId: string;
  readonly sources: ExtensionRuntimeSources;
  readonly storage?: Storage;
  /** False where organization policy forbids developer mode. */
  readonly developerModeAllowed?: () => boolean;
  readonly onFailure?: (record: InstalledExtension, failure: ExtensionFailure) => void;
  /** Where print requests wait for the user; without it extensions cannot print. */
  readonly printPrompts?: PrintPrompts;
  /** The open documents, for the model, selection and document services. */
  readonly documents?: ExtensionDocuments;
  /** The units of an open document, so printed tables show quantities as its panels do. */
  readonly units?: (documentId: string) => UnitSettings | null;
  /** Opens an extension's panel tab for `ui.open`. */
  readonly openUi?: (request: UiOpenRequest) => void;
  /** Told when an extension set or framed a document's selection, so its tab can give way to the document. */
  readonly onSelectionShown?: (extensionId: string, documentId: string) => void;
}): ExtensionPlatform {
  const storage = options.storage ?? window.localStorage;
  return new ExtensionPlatform({
    store: indexedDbExtensionStore(options.ownerId),
    activity: indexedDbActivityStore(options.ownerId),
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
    ...(options.printPrompts ? { printer: browserViewPrinter(options.printPrompts, undefined, options.units) } : {}),
    ...(options.documents ? { documents: options.documents } : {}),
    ...(options.openUi ? { openUi: options.openUi } : {}),
    ...(options.onSelectionShown ? { onSelectionShown: options.onSelectionShown } : {}),
    ...(options.onFailure ? { onFailure: options.onFailure } : {}),
  });
}
