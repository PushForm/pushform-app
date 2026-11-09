// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// @pushform/kernel: the geometry kernel's protocol, client and backends; the kernel itself is Rust (crates/native-kernel)
export const PACKAGE = '@pushform/kernel';

export * from './protocol';
export * from './meshChecks';
export { validateSolidMesh } from './validateSolid';
export type { KernelBackend, MeshProvider } from './backends/KernelBackend';
export { InlineBackend } from './backends/InlineBackend';
export { DeferredBackend } from './backends/DeferredBackend';
export { NativeKernelBackend, type NativeKernelTransport } from './backends/NativeKernelBackend';
export { KernelClient, toMeshWire, type CoalescedResult } from './client/KernelClient';

export * from './hardware';
