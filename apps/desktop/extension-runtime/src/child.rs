// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
use crate::{LINE_BYTES, read_line_bounded, validate_frame};
use serde::Deserialize;
use std::{
    borrow::Cow,
    io::{self, BufReader, Write},
    sync::mpsc::{self, SyncSender},
    thread,
    time::{Duration, Instant},
};
use tao::{
    event::Event,
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::{PageLoadEvent, WebViewBuilder, WebViewBuilderExtWindows, http::Response};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bootstrap {
    runtime: String,
    host: String,
}
enum Message {
    Ready,
    Input(String, SyncSender<()>),
    Stop,
}
pub fn run() -> Result<(), String> {
    let mut input = BufReader::new(io::stdin());
    let line = read_line_bounded(&mut input, 16 * 1024 * 1024)
        .map_err(|_| "Invalid runtime bootstrap.")?
        .ok_or("Missing runtime bootstrap.")?;
    let bootstrap: Bootstrap =
        serde_json::from_str(&line).map_err(|_| "Invalid runtime bootstrap.")?;
    if bootstrap.runtime.len() != 32
        || !bootstrap
            .runtime
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
        || bootstrap.host.is_empty()
        || bootstrap.host.len() > 2 * 1024 * 1024
    {
        return Err("Invalid runtime bootstrap bounds.".into());
    }
    let profile = std::env::temp_dir()
        .join("pushform-extension-runtimes")
        .join(&bootstrap.runtime);
    std::fs::create_dir_all(&profile)
        .map_err(|_| "Could not create the isolated runtime profile.")?;
    let event_loop = EventLoopBuilder::<Message>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("PushForm extension runtime")
        .with_visible(false)
        .build(&event_loop)
        .map_err(|_| "Could not create the runtime window.")?;
    let mut context = wry::WebContext::new(Some(profile));
    let ready_proxy = proxy.clone();
    let stop_proxy = proxy.clone();
    let origin = format!("http://pfext.{}.localhost/", bootstrap.runtime);
    let scheme_origin = format!("pfext://{}.localhost/", bootstrap.runtime);
    let page = scheme_origin.clone();
    let ready_origin = origin.clone();
    let ready_scheme = scheme_origin.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut context)
    .with_custom_protocol("pfext".into(), move |_id, request| {
      let (status, content_type, bytes): (u16, &str, Vec<u8>) = match (request.method().as_str(), request.uri().path()) {
        ("GET", "/") => (200, "text/html", b"<!doctype html><meta charset=utf-8><title>Extension runtime</title><script src='/host.js'></script>".to_vec()),
        ("GET", "/host.js") => (200, "text/javascript", bootstrap.host.as_bytes().to_vec()),
        _ => (404, "text/plain", Vec::new()),
      };
      Response::builder().status(status).header("Content-Type", content_type)
        .header("Content-Security-Policy", "default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'")
        .header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").body(Cow::Owned(bytes)).unwrap()
    })
    .with_ipc_handler(move |request| {
      if validate_frame(request.body()).is_err() { let _ = stop_proxy.send_event(Message::Stop); return; }
      let mut output = io::stdout().lock();
      if output.write_all(request.body().as_bytes()).and_then(|_| output.write_all(b"\n")).and_then(|_| output.flush()).is_err() { let _ = stop_proxy.send_event(Message::Stop); }
    })
    .with_navigation_handler(move |url| url == origin || url == scheme_origin)
    .with_on_page_load_handler(move |event, url| { if matches!(event, PageLoadEvent::Finished) && (url == ready_origin || url == ready_scheme) { let _ = ready_proxy.send_event(Message::Ready); } })
    .with_additional_browser_args("--js-flags=--max-old-space-size=256")
    .with_url(page).build(&window).map_err(|_| "Could not create the isolated runtime view.")?;
    let input_proxy = proxy.clone();
    thread::spawn(move || {
        while let Ok(Some(line)) = read_line_bounded(&mut input, LINE_BYTES) {
            if validate_frame(&line).is_err() {
                break;
            }
            let (acknowledged, response) = mpsc::sync_channel(1);
            if input_proxy
                .send_event(Message::Input(line, acknowledged))
                .is_err()
                || response.recv_timeout(Duration::from_secs(5)).is_err()
            {
                break;
            }
        }
        let _ = input_proxy.send_event(Message::Stop);
    });
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut ready = false;
    let mut pending: Option<(String, SyncSender<()>)> = None;
    event_loop.run(move |event, _, flow| {
        *flow = if ready {
            ControlFlow::Wait
        } else {
            ControlFlow::WaitUntil(deadline)
        };
        match event {
            Event::UserEvent(Message::Ready) => {
                ready = true;
            }
            Event::UserEvent(Message::Input(line, ack)) => {
                pending = Some((line, ack));
            }
            Event::UserEvent(Message::Stop) => {
                *flow = ControlFlow::Exit;
            }
            _ => {
                if !ready && Instant::now() >= deadline {
                    *flow = ControlFlow::Exit;
                }
            }
        }
        if ready {
            if let Some((line, ack)) = pending.take() {
                // The entire frame is a JSON string argument. Extension text is never interpreted as source.
                let argument = serde_json::to_string(&line).unwrap();
                let script = format!("window.__pfRuntimeReceive(JSON.parse({argument}));");
                if webview
                    .evaluate_script_with_callback(&script, move |_| {
                        let _ = ack.send(());
                    })
                    .is_err()
                {
                    *flow = ControlFlow::Exit;
                }
            }
        }
    });
}
