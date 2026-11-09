// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
use crate::{LINE_BYTES, read_line_bounded, validate_frame};
use std::os::windows::{
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::CommandExt,
};
use std::{
    io::{BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    System::{JobObjects::*, Threading::CREATE_NO_WINDOW},
};
const QUEUE_BYTES: usize = 16 * 1024 * 1024;
const JOB_MEMORY: usize = 1024 * 1024 * 1024;
struct OutputWindow {
    sent: u64,
    acknowledged: u64,
    frames: std::collections::VecDeque<(u64, usize)>,
    bytes: usize,
}
struct Control {
    child: Mutex<Child>,
    job: OwnedHandle,
    stopped: AtomicBool,
    output: Mutex<OutputWindow>,
    output_changed: Condvar,
}
impl Control {
    fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        self.output_changed.notify_all();
        // The job contains the helper and every browser descendant; the editor belongs to no such job.
        unsafe {
            TerminateJobObject(self.job.as_raw_handle() as HANDLE, 1);
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    fn reserve_output(&self, bytes: usize) -> Result<u64, String> {
        let mut output = self
            .output
            .lock()
            .map_err(|_| "Native output queue failed.")?;
        while !self.stopped.load(Ordering::SeqCst)
            && (output.frames.len() >= 16 || output.bytes + bytes > 8 * 1024 * 1024)
        {
            let (current, timeout) = self
                .output_changed
                .wait_timeout(output, std::time::Duration::from_secs(5))
                .map_err(|_| "Native output queue failed.")?;
            output = current;
            if timeout.timed_out() {
                return Err(
                    "limit.exceeded: The editor did not consume native runtime output.".into(),
                );
            }
        }
        if self.stopped.load(Ordering::SeqCst) {
            return Err("cancelled: The native runtime stopped.".into());
        }
        output.sent += 1;
        let sequence = output.sent;
        output.bytes += bytes;
        output.frames.push_back((sequence, bytes));
        Ok(sequence)
    }
    fn acknowledge(&self, sequence: u64) -> Result<(), String> {
        let mut output = self
            .output
            .lock()
            .map_err(|_| "Native output queue failed.")?;
        if sequence > output.sent {
            return Err("validation.failed: Unknown native output acknowledgement.".into());
        }
        if sequence <= output.acknowledged {
            return Ok(());
        }
        output.acknowledged = sequence;
        while output.frames.front().is_some_and(|(id, _)| *id <= sequence) {
            if let Some((_, bytes)) = output.frames.pop_front() {
                output.bytes -= bytes;
            }
        }
        self.output_changed.notify_all();
        Ok(())
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        self.stop();
    }
}
struct WriteRequest {
    line: String,
    done: SyncSender<Result<(), String>>,
}
pub struct Runtime {
    pub id: String,
    control: Arc<Control>,
    sender: SyncSender<WriteRequest>,
    queued: Arc<AtomicUsize>,
}
impl Runtime {
    pub fn spawn(
        executable: &Path,
        host_source: &str,
        on_message: impl Fn(&str, u64, String) -> bool + Send + 'static,
    ) -> Result<Self, String> {
        if host_source.is_empty() || host_source.len() > 2 * 1024 * 1024 {
            return Err("validation.failed: Invalid native host bootstrap.".into());
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut command = Command::new(executable);
        command
            .arg("--extension-runtime")
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        // No account/provider secrets or WebView environment overrides cross into the helper process.
        for name in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "LOCALAPPDATA",
            "APPDATA",
            "USERPROFILE",
            "PROGRAMFILES",
            "PROGRAMFILES(X86)",
            "PROGRAMDATA",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let mut child = command
            .spawn()
            .map_err(|_| "unavailable: Could not start the isolated extension helper.")?;
        let attach = || -> Result<OwnedHandle, String> {
            let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if raw.is_null() {
                return Err("unavailable: Native runtime containment is unavailable.".into());
            }
            let job = unsafe { OwnedHandle::from_raw_handle(raw as _) };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_MEMORY;
            limits.JobMemoryLimit = JOB_MEMORY;
            if unsafe {
                SetInformationJobObject(
                    raw,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
                || unsafe { AssignProcessToJobObject(raw, child.as_raw_handle() as HANDLE) } == 0
            {
                return Err(
                    "unavailable: Could not contain the native runtime process tree.".into(),
                );
            }
            Ok(job)
        };
        let job = match attach() {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let mut input = child
            .stdin
            .take()
            .ok_or("unavailable: Native input pipe is unavailable.")?;
        let output = child
            .stdout
            .take()
            .ok_or("unavailable: Native output pipe is unavailable.")?;
        let bootstrap = serde_json::json!({"runtime":id,"host":host_source}).to_string();
        if input
            .write_all(bootstrap.as_bytes())
            .and_then(|_| input.write_all(b"\n"))
            .is_err()
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("unavailable: Native initialization failed.".into());
        }
        let control = Arc::new(Control {
            child: Mutex::new(child),
            job,
            stopped: AtomicBool::new(false),
            output: Mutex::new(OutputWindow {
                sent: 0,
                acknowledged: 0,
                frames: Default::default(),
                bytes: 0,
            }),
            output_changed: Condvar::new(),
        });
        let queued = Arc::new(AtomicUsize::new(0));
        let (sender, receiver) = mpsc::sync_channel::<WriteRequest>(8);
        let writer_control = control.clone();
        let writer_queue = queued.clone();
        thread::spawn(move || {
            while let Ok(request) = receiver.recv() {
                let result = if writer_control.stopped.load(Ordering::SeqCst) {
                    Err("cancelled: The extension runtime stopped.".into())
                } else {
                    input
                        .write_all(request.line.as_bytes())
                        .and_then(|_| input.write_all(b"\n"))
                        .map_err(|_| "extension.failed: Native runtime input closed.".into())
                };
                writer_queue.fetch_sub(request.line.len(), Ordering::SeqCst);
                let failed = result.is_err();
                let _ = request.done.send(result);
                if failed {
                    writer_control.stop();
                    break;
                }
            }
        });
        let reader_control = control.clone();
        let reader_id = id.clone();
        thread::spawn(move || {
            let mut output = BufReader::new(output);
            let mut began = Instant::now();
            let mut bytes = 0usize;
            let mut frames = 0usize;
            while let Ok(Some(line)) = read_line_bounded(&mut output, LINE_BYTES) {
                if began.elapsed().as_secs() >= 1 {
                    began = Instant::now();
                    bytes = 0;
                    frames = 0;
                }
                bytes += line.len();
                frames += 1;
                if bytes > 256 * 1024 * 1024 || frames > 4096 || validate_frame(&line).is_err() {
                    break;
                }
                let sequence = match reader_control.reserve_output(line.len()) {
                    Ok(value) => value,
                    Err(_) => break,
                };
                if !on_message(&reader_id, sequence, line) {
                    break;
                }
            }
            reader_control.stop();
        });
        Ok(Self {
            id,
            control,
            sender,
            queued,
        })
    }
    pub fn post(&self, line: String) -> Result<(), String> {
        validate_frame(&line)?;
        if self.control.stopped.load(Ordering::SeqCst) {
            return Err("cancelled: The native runtime stopped.".into());
        }
        let length = line.len();
        #[allow(deprecated)]
        let reserved = self
            .queued
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value
                    .checked_add(length)
                    .filter(|total| *total <= QUEUE_BYTES)
            });
        if reserved.is_err() {
            self.stop();
            return Err("limit.exceeded: Native input queue is full.".into());
        }
        let (done, result) = mpsc::sync_channel(1);
        if self.sender.try_send(WriteRequest { line, done }).is_err() {
            self.queued.fetch_sub(length, Ordering::SeqCst);
            self.stop();
            return Err("limit.exceeded: Native input queue is full.".into());
        }
        result
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap_or_else(|_| {
                self.stop();
                Err("extension.failed: Native runtime input timed out.".into())
            })
    }
    pub fn process_count(&self) -> Result<u32, String> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                self.control.job.as_raw_handle() as HANDLE,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as _,
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err("Native process accounting is unavailable.".into());
        }
        Ok(info.ActiveProcesses)
    }
    pub fn acknowledge(&self, sequence: u64) -> Result<(), String> {
        self.control.acknowledge(sequence)
    }
    pub fn stop(&self) {
        self.control.stop();
        // Only the canonical, host-generated direct child of our profile directory may be removed.
        let root = std::env::temp_dir().join("pushform-extension-runtimes");
        let profile = root.join(&self.id);
        if let (Ok(root), Ok(target), Ok(metadata)) = (
            root.canonicalize(),
            profile.canonicalize(),
            std::fs::symlink_metadata(&profile),
        ) {
            if target.parent() == Some(root.as_path())
                && target.file_name().and_then(|name| name.to_str()) == Some(self.id.as_str())
                && metadata.is_dir()
                && !metadata.file_type().is_symlink()
            {
                let _ = std::fs::remove_dir_all(target);
            }
        }
    }
    pub fn stopped(&self) -> bool {
        self.control.stopped.load(Ordering::SeqCst)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop();
    }
}
