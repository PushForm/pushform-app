// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
// @pushform/extension-sdk: types and small helpers for PushForm extensions. MIT licensed, so extensions under any
// license can use it.
export type * from './context.ts';
export type * from './ui.ts';
export * from './errors.ts';
export * from './units.ts';

/** The extension API version this SDK describes; declare a matching range as `apiVersion` in the manifest. */
export const API_VERSION = '0.1.0';
