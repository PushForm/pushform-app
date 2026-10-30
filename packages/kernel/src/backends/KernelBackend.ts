// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { BodyRef, KernelRequest, MeshWire, ResFor } from '../protocol';
import { KernelError } from '../protocol';

/** Supplies the canonical mesh of a body/version so a backend can re-upload it after a worker restart or cache eviction. */
export type MeshProvider = (bodyId: number, version: number) => MeshWire | undefined;

/** Transport-agnostic way to run kernel requests. Swapping backends needs no change above `KernelClient`. */
export interface KernelBackend {
  request<R extends KernelRequest>(req: R): Promise<ResFor<R>>;
  /** Drop every in-flight request (rejected with code `Aborted`) and reset the worker. */
  abortAll(): void;
  dispose(): void;
  /** Optional: install the provider used to recover from `BodyNotCached`. */
  setMeshProvider?(provider: MeshProvider | undefined): void;
}

const MAX_REUPLOADS = 4;

function missingBody(e: unknown): BodyRef | undefined {
  if (!(e instanceof KernelError) || e.code !== 'BodyNotCached') return undefined;
  const d = e.details as Partial<BodyRef> | undefined;
  return typeof d?.bodyId === 'number' && typeof d.version === 'number' ? { bodyId: d.bodyId, version: d.version } : undefined;
}

/**
 * Send a request; when the worker answers `BodyNotCached`, upload the body from `provider` and
 * re-send. A request referencing several bodies may need several rounds.
 */
export async function sendWithReupload<R extends KernelRequest>(
  req: R,
  send: <Q extends KernelRequest>(q: Q) => Promise<ResFor<Q>>,
  provider: MeshProvider | undefined,
): Promise<ResFor<R>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(req);
    } catch (e) {
      const ref = missingBody(e);
      const mesh = ref !== undefined && attempt < MAX_REUPLOADS ? provider?.(ref.bodyId, ref.version) : undefined;
      if (ref === undefined || mesh === undefined) throw e;
      await send({ type: 'ensureBody', bodyId: ref.bodyId, version: ref.version, mesh });
    }
  }
}
