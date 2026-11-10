// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  ExtensionPlatform, localSettingsStore, startWebRuntime, storedDeveloperMode, type ExtensionDocuments, type ExtensionFailure, type InstalledExtension,
  type UiOpenRequest, type ExtensionAssetStore, type SettingsStore, SettingsConflictError,
  ExtensionRegistry, fetchDistribution, type RegistryOptions, type ExtensionPlatformOptions,
} from '@pushform/extensions';
import { ExtensionError } from '@pushform/extension-protocol';
import { CloudSettingsConflictError } from '@pushform/cloud';
import { indexedDbAssetStore } from './indexedDbAssetStore';
import type { UnitSettings } from '@pushform/core';
import { browserClipboardWriter, browserFilePicker } from './browserExtensionIo';
import { browserViewPrinter, type PrintPrompts } from './extensionPrint';
import type { FilePrompts } from './extensionFiles';
import { indexedDbActivityStore, indexedDbDistributionCache, indexedDbExtensionStore } from './indexedDbExtensionStore';

export { browserRunsExtensions } from './browserRunsExtensions';

/** The extension runtime's two worker bootstraps, bundled as classic scripts by the web build. */
export interface ExtensionRuntimeSources {
  readonly workerSource: string;
  /** Trusted shell runtime factory; absent in the browser. */
  readonly startRuntime?: ExtensionPlatformOptions['startRuntime'];
  readonly computeSource: string;
  /** Public trust anchors and endpoints embedded by the host build, never supplied by an extension or feed. */
  readonly distribution?: Pick<RegistryOptions, 'keys' | 'registryUrl' | 'revocationsUrl' | 'origins' | 'appVersion'>;
}
export interface AccountExtensionStorage { readonly assets: ExtensionAssetStore; readonly settings: SettingsStore }

/** The extension platform of a signed-in account in this browser. */
export function createBrowserExtensionPlatform(options: {
  readonly ownerId: string;
  readonly sources: ExtensionRuntimeSources;
  readonly storage?: Storage;
  readonly accountStorage?: AccountExtensionStorage;
  /** False where organization policy forbids developer mode. */
  readonly developerModeAllowed?: () => boolean;
  readonly onFailure?: (record: InstalledExtension, failure: ExtensionFailure) => void;
  /** Where print requests wait for the user; without it extensions cannot print. */
  readonly printPrompts?: PrintPrompts;
  readonly filePrompts?: FilePrompts;
  /** The open documents, for the model, selection and document services. */
  readonly documents?: ExtensionDocuments;
  readonly tools?: ExtensionPlatformOptions['tools'];
  readonly onToolRequested?: ExtensionPlatformOptions['onToolRequested'];
  /** The units of an open document, so printed tables show quantities as its panels do. */
  readonly units?: (documentId: string) => UnitSettings | null;
  /** Opens an extension's panel tab for `ui.open`. */
  readonly openUi?: (request: UiOpenRequest) => void;
  /** Told when an extension set or framed a document's selection, so its tab can give way to the document. */
  readonly onSelectionShown?: (extensionId: string, documentId: string) => void;
}): ExtensionPlatform {
  const storage = options.storage ?? window.localStorage;
  const localAssets = indexedDbAssetStore(options.ownerId);
  const unavailable = async (): Promise<never> => { throw new ExtensionError('unavailable','Account asset storage is not configured.'); };
  const noAccountAssets: ExtensionAssetStore = { list: unavailable, read: unavailable, put: unavailable, remove: unavailable, clear: unavailable };
  const localSettings = localSettingsStore(storage,options.ownerId);
  const noAccountSettings: SettingsStore = { load:unavailable,save:unavailable,remove:unavailable };
  const officialSettings: SettingsStore = options.accountStorage ? {
    load:id => options.accountStorage!.settings.load(id),
    remove:id => options.accountStorage!.settings.remove(id),
    async save(id,version,value,expected) {
      try { return await options.accountStorage!.settings.save(id,version,value,expected); }
      catch (error) { if (error instanceof CloudSettingsConflictError) throw new SettingsConflictError(); throw error; }
    },
  } : noAccountSettings;
  return new ExtensionPlatform({
    ...(options.sources.distribution ? { registry: new ExtensionRegistry({ ...options.sources.distribution, transport: fetchDistribution,
      cache: indexedDbDistributionCache(options.ownerId, `${options.sources.distribution.registryUrl}\0${options.sources.distribution.revocationsUrl}`) }) } : {}),
    store: indexedDbExtensionStore(options.ownerId),
    activity: indexedDbActivityStore(options.ownerId),
    developerMode: storedDeveloperMode(storage, options.developerModeAllowed),
    startRuntime: options.sources.startRuntime ?? ((record) => startWebRuntime({
      files: new Map(Object.entries(record.files)), main: record.manifest.main, wasm: record.manifest.wasm.length > 0,
      workerSource: options.sources.workerSource, computeSource: options.sources.computeSource,
    })),
    settingsStore: record => record.integrity === 'unsigned' ? localSettings : officialSettings,
    assetStore: record => record.integrity === 'unsigned' ? localAssets : options.accountStorage?.assets ?? noAccountAssets,
    filePicker: browserFilePicker((request, signal) => options.filePrompts?.ask(request, signal) ?? Promise.resolve(false)),
    clipboard: browserClipboardWriter(),
    fetchTransport: null,
    ...(options.printPrompts ? { printer: browserViewPrinter(options.printPrompts, undefined, options.units) } : {}),
    ...(options.documents ? { documents: options.documents } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.onToolRequested ? { onToolRequested: options.onToolRequested } : {}),
    ...(options.openUi ? { openUi: options.openUi } : {}),
    ...(options.onSelectionShown ? { onSelectionShown: options.onSelectionShown } : {}),
    ...(options.onFailure ? { onFailure: options.onFailure } : {}),
  });
}
