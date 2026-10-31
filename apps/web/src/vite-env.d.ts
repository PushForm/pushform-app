// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/// <reference types="vite/client" />

/** Build identity injected by `define` in vite.config.ts; see src/buildInfo.ts. */
declare const __PF_BUILD__: {
  readonly version: string;
  readonly commit: string;
  readonly date: string;
};

/** The extension runtime's worker bootstraps as classic script strings (extensionRuntime.ts). */
declare module 'virtual:pushform-extension-worker' {
  const workerSource: string;
  export default workerSource;
  export const computeSource: string;
}
