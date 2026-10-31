// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { runStepThread, type StepThreadRequest } from './stepThreads';

// One worker of the threaded STEP reader: see stepThreads.ts.
const scope = self as unknown as DedicatedWorkerGlobalScope;
runStepThread({ post: message => scope.postMessage(message), onMessage: handler => { scope.onmessage = (event: MessageEvent<StepThreadRequest>) => handler(event.data); } });
