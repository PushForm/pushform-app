// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
mod extension_runtime;
mod updates;
mod clipboard;
#[cfg(feature = "native-kernel")]
mod native_kernel;
mod step;
mod window_fit;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  if std::env::args().nth(1).as_deref() == Some("--extension-runtime") {
    if pushform_extension_runtime::child_main().is_err() { std::process::exit(1); }
    return;
  }
  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(extension_runtime::State::default())
    .on_page_load(|webview, payload| {
      if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
        use tauri::Manager;
        webview.state::<extension_runtime::State>().reload_owner(webview.label());
      }
    })
    .on_window_event(|window, event| {
      if matches!(event, tauri::WindowEvent::Destroyed) {
        use tauri::Manager;
        window.state::<extension_runtime::State>().close_owner(window.label());
      }
    })
    .manage(updates::Pending::default())
    .manage(clipboard::State::default())
    .invoke_handler(tauri::generate_handler![
      extension_runtime::extensions_runtime_supported,
      extension_runtime::extensions_runtime_start,
      extension_runtime::extensions_runtime_post,
      extension_runtime::extensions_runtime_ack,
      extension_runtime::extensions_runtime_stop,
      clipboard::layout_clipboard_write,
      clipboard::layout_clipboard_read,
      updates::update_enabled,
      updates::update_fetch,
      updates::update_install,
      step::step_convert,
      step::step_export,
      step::step_cancel,
      #[cfg(feature = "native-kernel")]
      native_kernel::native_kernel_available,
      #[cfg(feature = "native-kernel")]
      native_kernel::native_kernel_call,
      #[cfg(feature = "native-kernel")]
      native_kernel::native_kernel_abort
    ])
    .setup(|app| {
      use tauri::Manager;
      #[cfg(feature = "native-kernel")]
      native_kernel::manage(app);
      if let Some(window) = app.get_webview_window("main") {
        // macOS keeps its traffic lights over the overlay title bar; elsewhere the app draws its own window controls.
        #[cfg(not(target_os = "macos"))]
        window.set_decorations(false)?;
        // Without a native title bar the window cannot be dragged back once its edge is off screen, so it opens inside the screen.
        window_fit::fit_to_monitor(&window);
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
