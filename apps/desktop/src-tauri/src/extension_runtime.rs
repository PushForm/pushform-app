// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
#[cfg(windows)]
use pushform_extension_runtime::Runtime;
use serde::Serialize;
#[cfg(windows)]
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use tauri::{WebviewWindow, ipc::Channel};
#[derive(Clone, Serialize)]
pub struct Output {
    runtime: String,
    sequence: u64,
    frame: String,
}
#[cfg(windows)]
#[derive(Default)]
struct Data {
    runs: HashMap<String, (String, Arc<Runtime>)>,
    starting: usize,
    closed: HashSet<String>,
    generations: HashMap<String, u64>,
}
#[derive(Default)]
pub struct State {
    #[cfg(windows)]
    data: Arc<Mutex<Data>>,
}
impl State {
    pub fn close_owner(&self, owner: &str) {
        self.clear_owner(owner, true);
    }
    pub fn reload_owner(&self, owner: &str) {
        self.clear_owner(owner, false);
    }
    fn clear_owner(&self, owner: &str, closed: bool) {
        #[cfg(windows)]
        {
            let removed = if let Ok(mut data) = self.data.lock() {
                if closed {
                    data.closed.insert(owner.into());
                }
                *data.generations.entry(owner.into()).or_default() += 1;
                let ids: Vec<String> = data
                    .runs
                    .iter()
                    .filter(|(_, (window, _))| window == owner)
                    .map(|(id, _)| id.clone())
                    .collect();
                ids.into_iter()
                    .filter_map(|id| data.runs.remove(&id).map(|(_, runtime)| runtime))
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            std::thread::spawn(move || {
                for runtime in removed {
                    runtime.stop();
                }
            });
        }
        #[cfg(not(windows))]
        let _ = (owner, closed);
    }
    #[cfg(windows)]
    fn get(&self, owner: &str, id: &str) -> Result<Arc<Runtime>, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "unavailable: Native runtime state is unavailable.")?;
        let (window, runtime) = data
            .runs
            .get(id)
            .ok_or("unavailable: Native runtime is no longer active.")?;
        if window != owner {
            return Err("permission.denied: This runtime belongs to another window.".into());
        }
        Ok(runtime.clone())
    }
}
fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("permission.denied: Native runtimes are owned by the editor window.".into());
    }
    Ok(())
}
#[tauri::command]
pub fn extensions_runtime_supported(window: WebviewWindow) -> bool {
    window.label() == "main" && cfg!(windows)
}
#[tauri::command]
pub async fn extensions_runtime_start(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    source: String,
    output: Channel<Output>,
) -> Result<String, String> {
    main_window(&window)?;
    #[cfg(windows)]
    {
        let owner = window.label().to_string();
        let generation = {
            let mut data = state
                .data
                .lock()
                .map_err(|_| "unavailable: Native runtime state is unavailable.")?;
            if data.closed.contains(&owner) {
                return Err("cancelled: The editor window closed.".into());
            }
            data.runs.retain(|_, (_, runtime)| !runtime.stopped());
            if data.runs.len() + data.starting >= 2 {
                return Err("limit.exceeded: Two native extension runtimes are already active. Close or disable one before starting another.".into());
            }
            data.starting += 1;
            data.generations.get(&owner).copied().unwrap_or(0)
        };
        struct Admission(Arc<Mutex<Data>>);
        impl Drop for Admission {
            fn drop(&mut self) {
                if let Ok(mut data) = self.0.lock() {
                    data.starting -= 1;
                }
            }
        }
        let _admission = Admission(state.data.clone());
        let executable = std::env::current_exe()
            .map_err(|_| "unavailable: The runtime executable is unavailable.")?;
        let runtime = Arc::new(
            tauri::async_runtime::spawn_blocking(move || {
                Runtime::spawn(&executable, &source, move |runtime, sequence, frame| {
                    output
                        .send(Output {
                            runtime: runtime.into(),
                            sequence,
                            frame,
                        })
                        .is_ok()
                })
            })
            .await
            .map_err(|_| "extension.failed: The native runtime could not start.")??,
        );
        let id = runtime.id.clone();
        let mut data = state
            .data
            .lock()
            .map_err(|_| "unavailable: Native runtime state is unavailable.")?;
        if data.closed.contains(&owner)
            || data.generations.get(&owner).copied().unwrap_or(0) != generation
        {
            runtime.stop();
            return Err(
                "cancelled: The editor context changed while the runtime was starting.".into(),
            );
        }
        data.runs.insert(id.clone(), (owner, runtime));
        Ok(id)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, source, output);
        Err("extension.unsupported: This native engine is not enabled.".into())
    }
}
#[tauri::command]
pub async fn extensions_runtime_post(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    runtime: String,
    frame: String,
) -> Result<(), String> {
    main_window(&window)?;
    #[cfg(windows)]
    {
        let process = state.get(window.label(), &runtime)?;
        tauri::async_runtime::spawn_blocking(move || process.post(frame))
            .await
            .map_err(|_| "extension.failed: Native transport failed.")?
    }
    #[cfg(not(windows))]
    {
        let _ = (state, runtime, frame);
        Err("extension.unsupported: This native engine is not enabled.".into())
    }
}
#[tauri::command]
pub fn extensions_runtime_ack(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    runtime: String,
    sequence: u64,
) -> Result<(), String> {
    main_window(&window)?;
    #[cfg(windows)]
    {
        state.get(window.label(), &runtime)?.acknowledge(sequence)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, runtime, sequence);
        Err("extension.unsupported: This native engine is not enabled.".into())
    }
}
#[tauri::command]
pub async fn extensions_runtime_stop(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    runtime: String,
) -> Result<(), String> {
    main_window(&window)?;
    #[cfg(windows)]
    {
        let process = {
            let mut data = state
                .data
                .lock()
                .map_err(|_| "unavailable: Native runtime state is unavailable.")?;
            if let Some((owner, _)) = data.runs.get(&runtime) {
                if owner != window.label() {
                    return Err("permission.denied: This runtime belongs to another window.".into());
                }
            }
            data.runs.remove(&runtime).map(|(_, runtime)| runtime)
        };
        if let Some(process) = process {
            tauri::async_runtime::spawn_blocking(move || process.stop())
                .await
                .map_err(|_| "extension.failed: Native runtime shutdown failed.")?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (state, runtime);
        Ok(())
    }
}
