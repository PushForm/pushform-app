// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/// <reference types="vite/client" />

/** Build identity injected by `define` in vite.config.ts; see src/buildInfo.ts. */
declare const __PF_BUILD__: {
  readonly version: string;
  readonly commit: string;
  readonly date: string;
};
