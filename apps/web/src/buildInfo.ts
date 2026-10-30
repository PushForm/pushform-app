// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { BuildInfo } from '@pushform/ui';

/**
 * Version, commit and timestamp of this bundle, embedded by vite.config.ts at build time. A bundle
 * produced without that define (another bundler, a bare test) reports unknown values rather than
 * failing at startup.
 */
export const buildInfo: BuildInfo =
  typeof __PF_BUILD__ === 'undefined' ? { version: 'unknown', commit: 'unknown', date: '' } : __PF_BUILD__;
