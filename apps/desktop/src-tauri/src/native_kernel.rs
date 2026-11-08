// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! The native push/pull kernel, available in builds with the `native-kernel` feature. Requests are raw bytes over
//! Tauri's binary IPC, in the protocol of `crates/native-kernel/src/wire.rs`, and every request runs on its own
//! blocking thread so a slow boolean never holds up the next one. The webview's backend reruns anything that fails here
//! in WebAssembly.
use std::sync::Arc;

use pushform_native_kernel::{Kernel, KernelError};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;
use tauri::State;

#[tauri::command]
pub fn native_kernel_available() -> bool {
  true
}

#[tauri::command]
pub async fn native_kernel_call(request: Request<'_>, kernel: State<'_, Arc<Kernel>>) -> Result<Response, String> {
  let bytes = match request.body() {
    InvokeBody::Raw(bytes) => bytes.clone(),
    InvokeBody::Json(_) => return Err(KernelError::internal("native kernel requests are raw bytes".to_string()).to_json()),
  };
  let kernel = Arc::clone(kernel.inner());
  let outcome = tauri::async_runtime::spawn_blocking(move || kernel.handle(&bytes)).await;
  match outcome {
    Ok(Ok(response)) => Ok(Response::new(response)),
    Ok(Err(error)) => Err(error.to_json()),
    Err(join) => Err(KernelError::internal(join.to_string()).to_json()),
  }
}

#[tauri::command]
pub fn native_kernel_abort(kernel: State<'_, Arc<Kernel>>) {
  kernel.abort_all();
}

/// The kernel managed by the app. Installed when the feature is on, from `lib.rs`.
pub fn manage<R: tauri::Runtime>(app: &tauri::App<R>) {
  app.manage(Arc::new(Kernel::default()));
}
