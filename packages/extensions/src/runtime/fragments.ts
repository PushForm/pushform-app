// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { CommandRegistry, SERVICE_DOCUMENT, physicalCopySize, PHYSICAL_COPY_LIMITS, type NativePhysicalPlacement } from '@pushform/commands';
import {
  ExtensionError, FRAGMENT_LIMITS, fragmentCaptureSchema, fragmentTokenSchema, fragmentFileSchema, fragmentAssetSchema,
  fragmentPackageSchema, fragmentQuerySchema, fragmentMetadataListSchema, fragmentMetadataReadSchema, fragmentSaveSchema,
  fragmentExportSchema, fragmentDeriveSchema, fragmentProjectSchema, fragmentFitSchema, modelQuerySchema, type ExtensionManifest, type FragmentDescription,
} from '@pushform/extension-protocol';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { createRustWasmBackend } from '@pushform/kernel/rust-wasm';
import type { z } from 'zod';
import type { EntityRef } from '@pushform/model';
import type { Id } from '@pushform/core';
import type { ExtensionAssetStore } from '../assetStore';
import { captureNativeModelFragment, encodeNativeModelFragment, openNativeModelFragment, nativeFragmentClipboard, type NativeModelFragment } from '../modelFragments';
import type { NativePlacementAccess } from '../nativePlacementAccess';
import { NativeFragmentLibrary } from '../nativeFragmentLibrary';
import { ModelDocumentApi } from '../modelApi';
import { ModelMetadataApi } from '../metadataApi';
import { fitNativeModelFragment, projectNativeModelFragment } from '../nativeFragmentFit';
import type { ExtensionDocuments } from './documents';
import type { ExtensionFileTransfers } from './fileTransfers';
import type { ServiceImplementations } from './host';
import { fileRequest, type FilePicker } from './io';

type Snapshot = { bytes: Uint8Array; name: string; expires: number; controller: AbortController; identity: object };
export interface FragmentHostOptions {
  manifest: ExtensionManifest;
  documents?: ExtensionDocuments;
  files: ExtensionFileTransfers;
  packageFiles: ReadonlyMap<string, Uint8Array>;
  store: ExtensionAssetStore | null;
  picker: FilePicker;
  now?: () => number;
  /** Host-only override for headless tests; every fit owns and disposes its kernel. */
  createFitKernel?: () => KernelClient;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ExtensionError('validation.failed', 'The native module request is invalid or exceeds its limits.');
  return parsed.data;
}
const unavailable = (): never => { throw new ExtensionError('unavailable', 'This native module is unavailable or expired. Open it again.'); };

/** One runtime's native snapshots. Only safe summaries and this extension's metadata cross the broker. */
export class ExtensionFragmentHost implements NativePlacementAccess {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly lifetime = new AbortController();
  private readonly now: () => number;
  private cache: { handle: string; fragment: NativeModelFragment } | null = null;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly options: FragmentHostOptions) { this.now = options.now ?? (() => Date.now()); }

  services(): ServiceImplementations {
    return {
      'fragments.capture': (input, call) => {
        const query = parse(fragmentCaptureSchema, input);
        return this.create(call.signal, signal => {
          const id = query.document === undefined ? call.currentDocument() : call.document(query.document);
          const document = this.options.documents?.get(id);
          if (!document) throw new ExtensionError('document.closed', 'The source document has closed.');
          const host = document.nativeModel?.();
          if (!host) throw new ExtensionError('unavailable', 'This document does not support native module capture.');
          signal.throwIfAborted();
          const ref = { kind: query.ref.kind, id: query.ref.id as Id, path: query.ref.path as Id[] } as EntityRef;
          return captureNativeModelFragment(host, ref, query.expectedRevision, query.name);
        });
      },
      'fragments.openFile': (input, call) => {
        const query = parse(fragmentFileSchema, input);
        return this.create(call.signal, signal => openNativeModelFragment(this.options.files.capturedBytes(query.transfer, signal), query.name, signal));
      },
      'fragments.openAsset': (input, call) => {
        const query = parse(fragmentAssetSchema, input);
        return this.create(call.signal, async signal => {
          const fragment = await this.library().open(query.key, query.expectedRevision, signal);
          return { ...fragment, name: query.name };
        });
      },
      'fragments.openPackage': (input, call) => {
        const query = parse(fragmentPackageSchema, input);
        return this.create(call.signal, signal => {
          const bytes = Object.hasOwn(this.options.manifest.files, query.path) ? this.options.packageFiles.get(query.path) : undefined;
          if (!bytes) throw new ExtensionError('permission.denied', 'Choose a declared native file from this installed package.');
          return openNativeModelFragment(bytes, query.name, signal);
        });
      },
      'fragments.describe': (input, call) => this.use(parse(fragmentTokenSchema, input).fragment, call.signal, (fragment, snapshot, handle) => this.describe(handle, snapshot, fragment)),
      'fragments.query': (input, call) => {
        const query = parse(fragmentQuerySchema, input);
        return this.use(query.fragment, call.signal, fragment => {
          const filled = Object.fromEntries([...Object.keys(modelQuerySchema.shape).map(key => [key, null]), ...Object.entries(query.query)]);
          return { ...new ModelDocumentApi(this.commands(fragment), this.options.manifest.name).query(filled), revision: 1 };
        });
      },
      'fragments.metadataList': (input, call) => {
        const query = parse(fragmentMetadataListSchema, input);
        return this.use(query.fragment, call.signal, fragment => {
          this.checkRevision(query.query.expectedRevision);
          return { ...new ModelMetadataApi(this.commands(fragment)).list(this.options.manifest, { ...query.query, expectedRevision: fragment.host.doc.version }), revision: 1 };
        });
      },
      'fragments.metadataRead': (input, call) => {
        const query = parse(fragmentMetadataReadSchema, input);
        return this.use(query.fragment, call.signal, fragment => {
          this.checkRevision(query.query.expectedRevision);
          return { ...new ModelMetadataApi(this.commands(fragment)).read(this.options.manifest, { ...query.query, expectedRevision: fragment.host.doc.version }), revision: 1 };
        });
      },
      'fragments.derive': (input, call) => {
        const query = parse(fragmentDeriveSchema, input);
        this.live(call.signal); this.reap(); this.checkRevision(query.expectedRevision);
        const snapshot = this.snapshots.get(query.fragment); if (!snapshot) return unavailable();
        return this.create(AbortSignal.any([call.signal, snapshot.controller.signal]), async signal => {
          const fragment = await openNativeModelFragment(snapshot.bytes, query.name ?? snapshot.name, signal);
          new ModelMetadataApi(this.commands(fragment)).apply(this.options.manifest, { ...query.metadata, expectedRevision: fragment.host.doc.version }, signal);
          this.live(signal); return fragment;
        });
      },
      'fragments.project': (input, call) => {
        const query = parse(fragmentProjectSchema, input);
        return this.use(query.fragment, call.signal, (fragment, _snapshot, _handle, signal) => projectNativeModelFragment(fragment, query.axes, signal));
      },
      'fragments.fit': async (input, call) => {
        const query = parse(fragmentFitSchema, input);
        this.live(call.signal); this.reap(); this.checkRevision(query.expectedRevision);
        const snapshot = this.snapshots.get(query.fragment); if (!snapshot) return unavailable();
        let projection!: Awaited<ReturnType<typeof projectNativeModelFragment>>;
        const description = await this.create(AbortSignal.any([call.signal, snapshot.controller.signal]), async signal => {
          const fragment = await openNativeModelFragment(snapshot.bytes, query.name ?? snapshot.name, signal);
          this.live(signal);
          const kernel = this.options.createFitKernel?.() ?? new KernelClient(typeof Worker === 'undefined' ? new InlineBackend() : createRustWasmBackend().backend);
          const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 30_000);
          const active = AbortSignal.any([signal, timeout.signal]);
          let disposed = false;
          const stop = () => { if (!disposed) { disposed = true; kernel.dispose(); } }; active.addEventListener('abort', stop, { once: true });
          try {
            active.throwIfAborted();
            const result = await fitNativeModelFragment(fragment, { axes: query.axes, size: query.size, planes: query.planes, ...(query.pose ? { pose: query.pose } : {}), ...(query.anchor ? { anchor: query.anchor } : {}) }, kernel, active);
            projection = result.projection; this.live(active); return result.fragment;
          } catch (error) { active.throwIfAborted(); throw error; }
          finally { clearTimeout(timer); active.removeEventListener('abort', stop); stop(); }
        });
        return { description, projection };
      },
      'fragments.save': (input, call) => {
        const query = parse(fragmentSaveSchema, input);
        return this.use(query.fragment, call.signal, (fragment, _snapshot, _handle, signal) => this.library().save(fragment, query.key, query.expectedRevision, signal));
      },
      'fragments.export': (input, call) => {
        const query = parse(fragmentExportSchema, input);
        const request = fileRequest({ ...query, accept: [{ description: 'PushForm model', extensions: ['pf'] }] }, 'save', this.options.manifest.name);
        return this.use(query.fragment, call.signal, async (_fragment, snapshot, _handle, signal) => {
          const saved = await this.options.picker.save(request, snapshot.bytes.slice(), { signal, maxBytes: FRAGMENT_LIMITS.bytes });
          if (!saved) { signal.throwIfAborted(); throw new ExtensionError('cancelled', 'The module was not saved.'); }
          return { name: saved.name };
        });
      },
      'fragments.discard': (input, call) => {
        this.live(call.signal); this.release(parse(fragmentTokenSchema, input).fragment); return null;
      },
    };
  }
  /** Keep owned handles and their cancellation lease alive through one complete model batch. */
  withPlacements<T>(handles: readonly string[], signal: AbortSignal,
    run: (placements: ReadonlyMap<string, NativePhysicalPlacement>, active: AbortSignal) => Promise<T>): Promise<T> {
    return this.serial(signal, async active => {
      const snapshots = new Map<string, Snapshot>(), counts = new Map<string, number>();
      for (const handle of handles) {
        const snapshot = this.snapshots.get(handle); if (!snapshot) return unavailable();
        snapshots.set(handle, snapshot); counts.set(handle, (counts.get(handle) ?? 0) + 1);
      }
      active = AbortSignal.any([active, ...[...snapshots.values()].map(snapshot => snapshot.controller.signal)]);
      const placements = new Map<string, NativePhysicalPlacement>(); let entities = 0, vertices = 0;
      for (const [handle, snapshot] of snapshots) {
        const fragment = await this.load(handle, snapshot, active), size = physicalCopySize(fragment.host, fragment.root), count = counts.get(handle)!;
        entities += size.entities * count; vertices += size.vertices * count;
        if (entities > PHYSICAL_COPY_LIMITS.entities || vertices > PHYSICAL_COPY_LIMITS.vertices)
          throw new ExtensionError('limit.exceeded', 'The complete module batch exceeds its physical geometry budget. Place fewer modules at once.');
        placements.set(handle, { identity: snapshot.identity, clipboard: nativeFragmentClipboard(fragment), size });
      }
      this.live(active); return run(placements, active);
    });
  }
  dispose(): void {
    this.lifetime.abort();
    for (const handle of [...this.snapshots.keys()]) this.release(handle);
    this.cache = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  private commands(fragment: NativeModelFragment): CommandRegistry {
    return new CommandRegistry({ tx: fragment.host, services: new Map([[SERVICE_DOCUMENT, fragment.host]]) });
  }
  private checkRevision(revision?: number): void {
    if (revision !== undefined && revision !== 1) throw new ExtensionError('revision.stale', 'This native snapshot has revision one.');
  }
  private library(): NativeFragmentLibrary {
    if (!this.options.store) throw new ExtensionError('unavailable', 'Durable native module storage is unavailable. Nothing will be saved only in memory.');
    return new NativeFragmentLibrary(this.options.manifest.id, this.options.store);
  }
  private live(signal: AbortSignal): void { signal.throwIfAborted(); this.lifetime.signal.throwIfAborted(); }
  private async serial<T>(signal: AbortSignal, run: (active: AbortSignal) => Promise<T>): Promise<T> {
    this.live(signal); this.reap();
    if (this.busy) throw new ExtensionError('unavailable', 'Another native module operation is in progress. Wait for it to finish.');
    this.busy = true;
    try { return await run(AbortSignal.any([signal, this.lifetime.signal])); }
    finally { this.busy = false; this.reap(); }
  }
  private create(signal: AbortSignal, load: (active: AbortSignal) => NativeModelFragment | Promise<NativeModelFragment>): Promise<FragmentDescription> {
    return this.serial(signal, async active => {
      if (this.snapshots.size >= FRAGMENT_LIMITS.handles) throw new ExtensionError('limit.exceeded', 'Two native modules are already open. Discard one first.');
      this.cache = null;
      const fragment = await load(active), bytes = await encodeNativeModelFragment(fragment, active);
      this.live(active);
      if ([...this.snapshots.values()].reduce((sum, snapshot) => sum + snapshot.bytes.length, bytes.length) > FRAGMENT_LIMITS.sessionBytes)
        throw new ExtensionError('limit.exceeded', 'The native module snapshot quota is full. Discard another module first.');
      const handle = `fragment_${crypto.randomUUID().replaceAll('-', '')}`;
      const snapshot = { bytes, name: fragment.name, expires: this.now() + FRAGMENT_LIMITS.lifetimeMs, controller: new AbortController(), identity: {} };
      this.snapshots.set(handle, snapshot); this.cache = { handle, fragment };
      return this.describe(handle, snapshot, fragment);
    });
  }
  private use<T>(handle: string, signal: AbortSignal, run: (fragment: NativeModelFragment, snapshot: Snapshot, handle: string, active: AbortSignal) => T | Promise<T>): Promise<T> {
    return this.serial(signal, async active => {
      const snapshot = this.snapshots.get(handle); if (!snapshot) return unavailable();
      active = AbortSignal.any([active, snapshot.controller.signal]);
      const fragment = await this.load(handle, snapshot, active);
      return run(fragment, snapshot, handle, active);
    });
  }
  private async load(handle: string, snapshot: Snapshot, signal: AbortSignal): Promise<NativeModelFragment> {
    if (this.cache?.handle !== handle) {
      this.cache = null;
      const fragment = await openNativeModelFragment(snapshot.bytes, snapshot.name, signal);
      this.live(signal); this.cache = { handle, fragment };
    }
    this.live(signal); return this.cache.fragment;
  }
  private describe(handle: string, snapshot: Snapshot, fragment: NativeModelFragment): FragmentDescription {
    return { fragment: handle, name: snapshot.name, revision: 1, root: { kind: 'instance', id: fragment.root.id, path: [...fragment.root.path] },
      bounds: { min: [...fragment.bounds.min], max: [...fragment.bounds.max] }, byteLength: snapshot.bytes.length, expiresAt: snapshot.expires };
  }
  private release(handle: string): void {
    this.snapshots.get(handle)?.controller.abort(); this.snapshots.delete(handle);
    if (this.cache?.handle === handle) this.cache = null;
    this.reap();
  }
  private reap(): void {
    if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
    for (const [handle, snapshot] of this.snapshots) if (snapshot.expires <= this.now()) {
      snapshot.controller.abort(); this.snapshots.delete(handle); if (this.cache?.handle === handle) this.cache = null;
    }
    if (!this.lifetime.signal.aborted && this.snapshots.size)
      this.timer = setTimeout(() => this.reap(), Math.max(1, Math.min(...[...this.snapshots.values()].map(snapshot => snapshot.expires)) - this.now()));
  }
}
