// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
#![cfg(windows)]
use pushform_extension_runtime::Runtime;
use std::{
    path::Path,
    sync::mpsc,
    time::{Duration, Instant},
};
const ECHO: &str =
    "window.__pfRuntimeReceive = frame => window.ipc.postMessage(JSON.stringify(frame));";
fn start(source: &str) -> (Runtime, mpsc::Receiver<(u64, String)>) {
    let (tx, rx) = mpsc::channel();
    let runtime = Runtime::spawn(
        Path::new(env!("CARGO_BIN_EXE_pushform-extension-runtime")),
        source,
        move |_runtime, sequence, frame| tx.send((sequence, frame)).is_ok(),
    )
    .unwrap();
    (runtime, rx)
}
fn wait_stopped(runtime: &Runtime) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while runtime.process_count().unwrap() != 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(runtime.process_count().unwrap(), 0);
}
#[test]
fn native_transport_and_process_ownership_are_independent() {
    let (first, a) = start(ECHO);
    let (second, b) = start(ECHO);
    assert_ne!(first.id, second.id);
    let input = r#"{"id":1,"index":0,"count":1,"data":"first"}"#;
    first.post(input.into()).unwrap();
    let (sequence, response) = a.recv_timeout(Duration::from_secs(10)).unwrap();
    first.acknowledge(sequence).unwrap();
    assert_eq!(response, input);
    assert!(b.try_recv().is_err());
    first.stop();
    first.stop();
    wait_stopped(&first);
    assert!(first.post(input.into()).is_err());
    second.post(input.replace("first", "second")).unwrap();
    let (sequence, response) = b.recv_timeout(Duration::from_secs(10)).unwrap();
    second.acknowledge(sequence).unwrap();
    assert!(response.contains("second"));
    second.stop();
    wait_stopped(&second);
}
#[test]
fn a_hung_view_and_all_browser_descendants_end_without_a_javascript_acknowledgement() {
    let (runtime, _output) = start("window.__pfRuntimeReceive = () => { for (;;) {} };");
    runtime
        .post(r#"{"id":1,"index":0,"count":1,"data":"hang"}"#.into())
        .unwrap();
    std::thread::sleep(Duration::from_millis(500));
    let start = Instant::now();
    runtime.stop();
    wait_stopped(&runtime);
    assert!(start.elapsed() < Duration::from_secs(3));
}

#[test]
fn unacknowledged_output_is_bounded_and_ends_the_runtime() {
    let (runtime, output) = start(
        "window.__pfRuntimeReceive = frame => { for (let id = 1; id <= 64; id++) window.ipc.postMessage(JSON.stringify({ ...frame, id })); };",
    );
    runtime
        .post(r#"{"id":1,"index":0,"count":1,"data":"flood"}"#.into())
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while !runtime.stopped() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(runtime.stopped());
    wait_stopped(&runtime);
    assert_eq!(output.try_iter().count(), 16);
}
