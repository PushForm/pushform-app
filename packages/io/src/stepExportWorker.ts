// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { writeStepWithModule } from './stepExport';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<{ request: Uint8Array }>) => {
  try {
    const bytes = await writeStepWithModule(event.data.request);
    scope.postMessage({ type: 'result', bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (cause) {
    scope.postMessage({ type: 'error', message: cause instanceof Error ? cause.message : 'Could not write this model as STEP.' });
  }
};
