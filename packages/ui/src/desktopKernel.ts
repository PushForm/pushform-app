// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { invoke, isTauri } from '@tauri-apps/api/core';
import { NativeKernelBackend, type KernelBackend, type NativeKernelTransport } from '@pushform/kernel';

/** Set by the app's build config; present and true only in a desktop build made with the native kernel switch. */
declare const __PF_NATIVE_KERNEL__: boolean | undefined;

const tauriTransport: NativeKernelTransport = {
  available: () => invoke<boolean>('native_kernel_available'),
  call: (request) => invoke<ArrayBuffer>('native_kernel_call', request),
  abort: () => invoke('native_kernel_abort'),
};

/**
 * The kernel backend for a desktop build made with the native kernel switch: every request runs in the native Rust
 * kernel (see `NativeKernelBackend`), and `worker`, the same WebAssembly kernel the web app uses, handles any request
 * the native kernel cannot finish. Elsewhere, including every web build and the default desktop build, this is `worker`
 * itself. The switch is compiled out of the bundle when off, so nothing here reaches the web build.
 */
export function desktopKernelBackend(worker: KernelBackend): KernelBackend {
  if (typeof __PF_NATIVE_KERNEL__ === 'undefined' || !__PF_NATIVE_KERNEL__ || !isTauri()) return worker;
  return new NativeKernelBackend(worker, tauriTransport);
}
