// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { runNativeFileRequestAsync, nativeFileTransferables, type NativeFileRequest } from './nativeFileClient';

/** Disposable worker for native archive compression and inflation (see `nativeFileClient.ts`). */
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<NativeFileRequest>) => {
  try {
    const result = await runNativeFileRequestAsync(event.data);
    scope.postMessage({ type: 'result', result }, nativeFileTransferables(result));
  } catch (cause) {
    scope.postMessage({ type: 'error', message: cause instanceof Error ? cause.message : 'Could not process the document.' });
  }
};
