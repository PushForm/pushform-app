// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { prepareSketchUpLayout } from './sketchupLayout';

export interface LayoutWorkerRequest { bytes: Uint8Array; fileName: string }

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<LayoutWorkerRequest>) => {
  try {
    // The prepared state is plain data without typed arrays, so it is cloned rather than transferred.
    scope.postMessage({ type: 'result', prepared: prepareSketchUpLayout(event.data.bytes, event.data.fileName) });
  } catch (cause) {
    scope.postMessage({ type: 'error', message: cause instanceof Error ? cause.message : 'Could not import LayOut document.' });
  }
};
