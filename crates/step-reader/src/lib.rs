// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! STEP reading for PushForm: SolidCraft's reader parses the file and converts its solids one at a time,
//! then each distinct part is meshed once in its own frame and every placement of it reported with a
//! matrix, so the app can make one definition per part and place it as many times as the file does.
//!
//! The C ABI keeps the module free of any binding generator. A reading is a handle; the caller pushes
//! `step` until it returns 0, then takes the result as one binary buffer (little-endian, 8-byte aligned
//! sections; see `write_result`), which the TypeScript side decodes into mesh parts. Lengths are meters.

use std::collections::{HashMap, VecDeque};

#[cfg(all(target_arch = "wasm32", feature = "threads"))]
mod alloc;
#[cfg(all(target_arch = "wasm32", feature = "threads"))]
#[global_allocator]
static ALLOC: alloc::CachingAlloc = alloc::CachingAlloc;
use std::sync::{Arc, Condvar, Mutex};

use solidcraft_geom::Vec3;
use solidcraft_kernel::{ImportedBody, StepNode, StepReading};

/// Full turns are divided into 24 facets, as circles drawn in the app are.
const ANGLE: f64 = std::f64::consts::PI / 12.0;
/// Chord tolerance as a fraction of each body's size, coarser than the kernel's own display setting since the angle
/// below already keeps curves round; a floor in mm.
const CHORD_RATIO: f64 = 4e-3;
const CHORD_FLOOR_MM: f64 = 1e-3;
/// Chord tolerance of the plain tessellation (mode 0), as a fraction of the body's size.
const FACES_CHORD_RATIO: f64 = 1e-3;
const MM: f64 = 1e-3;
/// The app's vertex merge tolerance (0.001", in meters): points this close are one point to the converter, so the
/// mesh is welded and cleaned at the same scale here.
const MERGE_TOL: f64 = 2.54e-5;

struct Reading {
    reading: Option<StepReading>,
    pipe: Pipeline,
    mode: u32,
    threshold: u32,
    result: Option<Vec<u8>>,
}

impl Reading {
    /// Parse and plan `text`; `threads` is how many threads the kernel and the meshing may use (1: none).
    fn open(text: &str, mode: u32, threshold: u32, threads: usize) -> Result<Reading, String> {
        solidcraft_kernel::set_threads(threads);
        let reading = StepReading::with_workers(text, threads).map_err(|e| e.to_string())?;
        let pipe = Pipeline::new(&reading, mode, threads);
        Ok(Reading { reading: Some(reading), pipe, mode, threshold, result: None })
    }
    /// Convert the next solids and hand the bodies they made to the meshing. False once every solid is converted.
    fn step(&mut self) -> bool {
        let Some(reading) = self.reading.as_mut() else { return false };
        let more = reading.step();
        self.pipe.absorb(reading);
        more
    }
    /// Finish the conversion (converting whatever is left) and close the meshing queue.
    fn finish(&mut self) -> Result<(), String> {
        let Some(mut reading) = self.reading.take() else { return Err("the reading is finished".into()) };
        while reading.step() { self.pipe.absorb(&reading); }
        self.pipe.absorb(&reading);
        let import = reading.finish().map_err(|e| e.to_string())?;
        self.pipe.finish(import.warnings, import.schema, import.system);
        Ok(())
    }
    fn result(&mut self) -> Result<Vec<u8>, String> {
        self.pipe.result(self.mode, self.threshold)
    }
}

static mut READINGS: Vec<Option<Box<Reading>>> = Vec::new();

#[allow(static_mut_refs)]
fn readings() -> &'static mut Vec<Option<Box<Reading>>> {
    // The host calls the ABI from one thread; the meshing threads only touch the pipeline's pool.
    unsafe { &mut READINGS }
}
fn get(handle: u32) -> Option<&'static mut Reading> {
    readings().get_mut(handle as usize).and_then(|r| r.as_deref_mut())
}
fn fail(message: String) -> u32 {
    LAST_ERROR.with(|cell| *cell.borrow_mut() = Some(message));
    0
}

/// Threaded build: set up the main thread for the C library's threads (its thread descriptor), which a command does on
/// start but a library leaves to the host. Call it once after instantiation, before anything else; without it the
/// first thread-local key the program makes walks an unmade thread list and never returns.
///
/// # Safety
/// Call it once, on the instantiating thread, before any other export.
#[cfg(all(target_arch = "wasm32", feature = "threads"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_init() {
    unsafe extern "C" { fn __wasi_init_tp(); }
    unsafe { __wasi_init_tp() };
}

/// Allocate `len` bytes the caller fills with the file's text; freed by `pf_free`.
#[unsafe(no_mangle)]
pub extern "C" fn pf_alloc(len: u32) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len as usize);
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}
/// # Safety
/// `ptr` and `len` must be what `pf_alloc` returned and was given.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_free(ptr: *mut u8, len: u32) {
    if !ptr.is_null() {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len as usize) });
    }
}

/// Meshing mode bits. `MODE_DISPLAY`: the kernel's display mesh (faces share their boundary points, curves are
/// divided by angle, flat faces are gridded) instead of the plain chord-tolerance tessellation. `MODE_WELD`: weld
/// vertices at the app's merge tolerance and drop triangles that collapse. `MODE_SIMPLIFY`: re-triangulate flat
/// faces from their outlines (display mesh only).
pub const MODE_DISPLAY: u32 = 1;
pub const MODE_WELD: u32 = 2;
pub const MODE_SIMPLIFY: u32 = 4;

/// Parse and plan a STEP file. Returns a handle (1-based), or 0 when it failed (`pf_error_*` has the reason).
/// `threshold`: flat faces are re-triangulated (`MODE_SIMPLIFY`) only when the placed parts hold more triangles than
/// this, since below it the app merges flat facets into faces itself. `threads`: how many threads the host offers
/// (1: none); the kernel converts and the meshing runs on them where the build has threads.
///
/// # Safety
/// `ptr` and `len` must describe readable memory (`pf_alloc`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_step_open(ptr: *const u8, len: u32, mode: u32, threshold: u32, threads: u32) -> u32 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    let text = String::from_utf8_lossy(bytes);
    let list = readings();
    let slot = list.len();
    match Reading::open(&text, mode, threshold, (threads as usize).clamp(1, 64)) {
        Ok(reading) => { list.push(Some(Box::new(reading))); (slot + 1) as u32 }
        Err(e) => fail(e),
    }
}

thread_local! { static LAST_ERROR: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) }; }

/// Solids planned, and converted so far, for progress: packed as `done << 32 | total`.
#[unsafe(no_mangle)]
pub extern "C" fn pf_step_progress(handle: u32) -> u64 {
    match get(handle.wrapping_sub(1)) {
        Some(r) => {
            let (done, total) = r.reading.as_ref().map_or((r.pipe.planned, r.pipe.planned), |reading| reading.progress());
            ((done as u64) << 32) | (total as u64 & 0xffff_ffff)
        }
        None => 0,
    }
}

/// Convert the next solids; the bodies they make go to the meshing threads at once (the threaded builds). Returns 1
/// while more remain, 0 when every solid is converted (or the reading is gone).
#[unsafe(no_mangle)]
pub extern "C" fn pf_step_step(handle: u32) -> u32 {
    get(handle.wrapping_sub(1)).is_some_and(|r| r.step()) as u32
}

/// Finish the conversion. Returns 1, or 0 on failure (see `pf_error_*`). Then, without threads, the caller meshes one
/// part per `pf_step_mesh`; with threads it polls `pf_step_mesh_done`. `pf_step_result` follows either.
#[unsafe(no_mangle)]
pub extern "C" fn pf_step_finish(handle: u32) -> u32 {
    let Some(entry) = get(handle.wrapping_sub(1)) else { return 0 };
    match entry.finish() { Ok(()) => 1, Err(e) => fail(e) }
}
/// Bodies whose part is meshed, of the bodies planned: `done << 32 | total`. Moves during the conversion too, since
/// the meshing keeps pace with it.
#[unsafe(no_mangle)]
pub extern "C" fn pf_step_mesh_progress(handle: u32) -> u64 {
    match get(handle.wrapping_sub(1)) {
        Some(r) => ((r.pipe.placed_done() as u64) << 32) | (r.pipe.planned as u64 & 0xffff_ffff),
        None => 0,
    }
}
/// Without threads: mesh the next distinct part on the calling thread. Returns 1 while parts remain, else 0 (also when
/// threads do the meshing: poll `pf_step_mesh_done` instead).
#[unsafe(no_mangle)]
pub extern "C" fn pf_step_mesh(handle: u32) -> u32 {
    get(handle.wrapping_sub(1)).is_some_and(|r| r.pipe.mesh_one() && !r.pipe.inline.is_empty()) as u32
}
/// 1 when the conversion is finished and every distinct part is meshed, else 0.
#[unsafe(no_mangle)]
pub extern "C" fn pf_step_mesh_done(handle: u32) -> u32 {
    get(handle.wrapping_sub(1)).is_some_and(|r| r.pipe.is_done()) as u32
}
/// Build the result buffer once every body is meshed (meshing what is left on the calling thread where no threads do
/// it). Returns its length, or 0 when nothing was read or the threads are still meshing.
#[unsafe(no_mangle)]
pub extern "C" fn pf_step_result(handle: u32) -> u32 {
    let Some(entry) = get(handle.wrapping_sub(1)) else { return 0 };
    match entry.result() {
        Ok(buffer) => { let len = buffer.len() as u32; entry.result = Some(buffer); len }
        Err(e) => fail(e),
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn pf_step_result_ptr(handle: u32) -> *const u8 {
    get(handle.wrapping_sub(1)).and_then(|r| r.result.as_ref()).map_or(std::ptr::null(), |b| b.as_ptr())
}
/// Drop a reading and everything it holds; meshing threads still at work stop after their part.
#[unsafe(no_mangle)]
pub extern "C" fn pf_step_close(handle: u32) {
    if let Some(slot) = readings().get_mut(handle.wrapping_sub(1) as usize) {
        *slot = None;
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn pf_error_len() -> u32 {
    LAST_ERROR.with(|cell| cell.borrow().as_ref().map_or(0, |e| e.len() as u32))
}
#[unsafe(no_mangle)]
pub extern "C" fn pf_error_ptr() -> *const u8 {
    LAST_ERROR.with(|cell| cell.borrow().as_ref().map_or(std::ptr::null(), |e| e.as_ptr()))
}

// --- the meshing pipeline ----------------------------------------------------------------------

/// Whether this build can mesh on threads: natively, and in WebAssembly built for `wasm32-wasip1-threads` with the
/// `threads` feature, when the host spawns the threads it asks for.
const fn has_threads() -> bool { cfg!(any(not(target_arch = "wasm32"), feature = "threads")) }

/// The queue the meshing threads take jobs from, and where they leave the meshes: a job is a distinct part (the body
/// to mesh, in its own frame), numbered by the pipeline.
struct Pool {
    mode: u32,
    queue: Mutex<Queue>,
    ready: Condvar,
    results: Mutex<Vec<(usize, Option<Mesh>)>>,
}
struct Queue { jobs: VecDeque<(usize, ImportedBody, M4)>, closed: bool }
impl Pool {
    fn push(&self, job: usize, body: ImportedBody, to_local: M4) {
        self.queue.lock().unwrap().jobs.push_back((job, body, to_local));
        self.ready.notify_one();
    }
    fn close(&self) {
        self.queue.lock().unwrap().closed = true;
        self.ready.notify_all();
    }
    /// A thread's life: mesh jobs until the queue is closed and empty.
    fn work(&self) {
        loop {
            let next = {
                let mut q = self.queue.lock().unwrap();
                loop {
                    if let Some(job) = q.jobs.pop_front() { break Some(job); }
                    if q.closed { break None; }
                    q = self.ready.wait(q).unwrap();
                }
            };
            let Some((job, body, to_local)) = next else { return };
            let mesh = mesh_body(&body, &to_local, self.mode);
            self.results.lock().unwrap().push((job, mesh));
        }
    }
    fn take(&self) -> Vec<(usize, Option<Mesh>)> { std::mem::take(&mut *self.results.lock().unwrap()) }
}

/// Meshing that keeps pace with the conversion: as the reader converts solids (in the order it chooses), each new
/// body is either a repeat of an item already queued (a rigid placement of the same part reuses its mesh) or a new
/// job for the meshing threads; without threads the jobs wait for the caller's `pf_step_mesh` loop. Bodies are known
/// by their planned index, which the reader's tree uses, so placements are settled before anything is converted.
struct Pipeline {
    mode: u32,
    planned: usize,
    /// The world placement of every planned solid.
    placements: Vec<M4>,
    seen: Vec<bool>,
    /// The bodies converted, by planned index.
    bodies: Vec<Option<ImportedBody>>,
    part_of_item: HashMap<u64, usize>,
    /// Job: (planned index of the body meshed, frame of the part).
    jobs: Vec<(usize, M4)>,
    /// (job, planned index, placement) for every converted body.
    placed: Vec<(usize, usize, M4)>,
    /// Per job: None while pending, Some(None) when the part could not be meshed.
    meshes: Vec<Option<Option<Mesh>>>,
    meshed: usize,
    pool: Arc<Pool>,
    /// Threads meshing from the pool (0: the caller meshes `inline`).
    threads: usize,
    inline: VecDeque<usize>,
    warnings: Vec<String>,
    schema: String,
    system: String,
    finished: bool,
}
impl Pipeline {
    fn new(reading: &StepReading, mode: u32, threads: usize) -> Pipeline {
        let planned = reading.planned();
        let pool = Arc::new(Pool { mode, queue: Mutex::new(Queue { jobs: VecDeque::new(), closed: false }), ready: Condvar::new(), results: Mutex::new(Vec::new()) });
        let mut started = 0;
        if has_threads() && threads > 1 {
            for _ in 0..threads {
                let worker = pool.clone();
                // Meshing recurses into the kernel; a thread's stack lives in linear memory, so give it room.
                match std::thread::Builder::new().name("pushform-mesh".into()).stack_size(8 << 20).spawn(move || worker.work()) {
                    Ok(_) => started += 1,
                    Err(_) => break,
                }
            }
        }
        Pipeline { mode, planned, placements: body_placements(reading.tree(), planned), seen: vec![false; planned], bodies: (0..planned).map(|_| None).collect(),
            part_of_item: HashMap::new(), jobs: Vec::new(), placed: Vec::new(), meshes: Vec::new(), meshed: 0, pool, threads: started, inline: VecDeque::new(),
            warnings: Vec::new(), schema: String::new(), system: String::new(), finished: false }
    }
    /// Take up the bodies the reader converted since the last call.
    fn absorb(&mut self, reading: &StepReading) {
        for (i, body) in reading.converted_bodies() {
            if i >= self.planned || self.seen[i] { continue; }
            self.seen[i] = true;
            let world = self.placements[i];
            // A repeated item is meshed once in the frame of its first rigid placement; a non-rigid placement meshes itself.
            if let Some(&job) = self.part_of_item.get(&body.source_item)
                && rigid_inverse(&world).is_some()
            {
                self.placed.push((job, i, world));
                self.bodies[i] = Some(body.clone());
                continue;
            }
            let inverse = rigid_inverse(&world);
            let (to_local, placement) = match inverse { Some(inv) => (inv, world), None => (IDENTITY, IDENTITY) };
            let job = self.jobs.len();
            self.jobs.push((i, to_local));
            self.meshes.push(None);
            if inverse.is_some() { self.part_of_item.insert(body.source_item, job); }
            self.placed.push((job, i, placement));
            if self.threads > 0 { self.pool.push(job, body.clone(), to_local); } else { self.inline.push_back(job); }
            self.bodies[i] = Some(body.clone());
        }
    }
    fn poll(&mut self) {
        for (job, mesh) in self.pool.take() {
            if let Some(slot @ None) = self.meshes.get_mut(job) { *slot = Some(mesh); self.meshed += 1; }
        }
    }
    /// Mesh the next waiting part on this thread; false when none waits.
    fn mesh_one(&mut self) -> bool {
        let Some(job) = self.inline.pop_front() else { return false };
        let (i, to_local) = self.jobs[job];
        let mesh = self.bodies[i].as_ref().and_then(|body| mesh_body(body, &to_local, self.mode));
        if self.meshes[job].is_none() { self.meshes[job] = Some(mesh); self.meshed += 1; }
        true
    }
    fn is_done(&mut self) -> bool {
        self.poll();
        self.finished && self.meshed == self.jobs.len()
    }
    /// Converted bodies whose part is meshed (a reused placement counts with the part it shares).
    fn placed_done(&mut self) -> usize {
        self.poll();
        self.placed.iter().filter(|(job, _, _)| self.meshes[*job].is_some()).count()
    }
    fn finish(&mut self, warnings: Vec<String>, schema: String, system: String) {
        self.warnings = warnings;
        self.schema = schema;
        self.system = system;
        self.finished = true;
        self.pool.close();
    }
    fn result(&mut self, mode: u32, threshold: u32) -> Result<Vec<u8>, String> {
        if !self.finished { return Err("the conversion is not finished".into()); }
        while self.mesh_one() {}
        if !self.is_done() { return Err("the meshing threads have not finished".into()); }
        // Parts that failed to mesh drop out with their placements; the rest are renumbered.
        let mut renumber: HashMap<usize, usize> = HashMap::new();
        let mut parts: Vec<Part> = Vec::new();
        for (job, mesh) in self.meshes.iter_mut().enumerate() {
            if let Some(Some(mesh)) = mesh.take() { renumber.insert(job, parts.len()); parts.push(Part { mesh, placement_inverse: self.jobs[job].1 }); }
        }
        let placed: Vec<(usize, &ImportedBody, M4)> = self.placed.iter()
            .filter_map(|&(job, i, m)| Some((*renumber.get(&job)?, self.bodies[i].as_ref()?, m))).collect();
        Ok(write_result(parts, &placed, &self.warnings, &self.schema, &self.system, mode, threshold))
    }
}
impl Drop for Pipeline {
    fn drop(&mut self) { self.pool.close(); }
}

// --- result encoding ---------------------------------------------------------------------------

struct Writer(Vec<u8>);
impl Writer {
    fn u32(&mut self, v: u32) { self.0.extend_from_slice(&v.to_le_bytes()); }
    fn f64(&mut self, v: f64) { self.0.extend_from_slice(&v.to_le_bytes()); }
    fn f32(&mut self, v: f32) { self.0.extend_from_slice(&v.to_le_bytes()); }
    fn text(&mut self, s: &str) { let b = s.as_bytes(); self.u32(b.len() as u32); self.0.extend_from_slice(b); self.pad(); }
    fn pad(&mut self) { while self.0.len() % 8 != 0 { self.0.push(0); } }
    fn u32s(&mut self, v: &[u32]) { self.u32(v.len() as u32); for x in v { self.u32(*x); } self.pad(); }
    fn f64s(&mut self, v: &[f64]) { self.u32(v.len() as u32); self.pad(); for x in v { self.f64(*x); } }
}

type M4 = [[f64; 4]; 4];
const IDENTITY: M4 = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]];
fn mul(a: &M4, b: &M4) -> M4 {
    let mut out = [[0.0; 4]; 4];
    for c in 0..4 { for r in 0..4 { out[c][r] = (0..4).map(|k| a[k][r] * b[c][k]).sum(); } }
    out
}
/// Inverse of a rigid placement (rotation and translation); None when the matrix scales, shears or mirrors.
fn rigid_inverse(m: &M4) -> Option<M4> {
    let cols = [[m[0][0], m[0][1], m[0][2]], [m[1][0], m[1][1], m[1][2]], [m[2][0], m[2][1], m[2][2]]];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for i in 0..3 {
        if (dot(cols[i], cols[i]) - 1.0).abs() > 1e-6 { return None; }
        for j in 0..i { if dot(cols[i], cols[j]).abs() > 1e-6 { return None; } }
    }
    let det = cols[0][0] * (cols[1][1] * cols[2][2] - cols[1][2] * cols[2][1]) - cols[1][0] * (cols[0][1] * cols[2][2] - cols[0][2] * cols[2][1])
        + cols[2][0] * (cols[0][1] * cols[1][2] - cols[0][2] * cols[1][1]);
    if det < 0.0 || (m[0][3], m[1][3], m[2][3], m[3][3]) != (0.0, 0.0, 0.0, 1.0) { return None; }
    let t = [m[3][0], m[3][1], m[3][2]];
    let mut out = IDENTITY;
    for c in 0..3 { for r in 0..3 { out[c][r] = m[r][c]; } }
    for r in 0..3 { out[3][r] = -dot(cols[r], t); }
    Some(out)
}
fn apply(m: &M4, p: Vec3) -> [f64; 3] {
    [
        m[0][0] * p.x + m[1][0] * p.y + m[2][0] * p.z + m[3][0],
        m[0][1] * p.x + m[1][1] * p.y + m[2][1] * p.z + m[3][1],
        m[0][2] * p.x + m[1][2] * p.y + m[2][2] * p.z + m[3][2],
    ]
}

/// The world placement of every body: the product of node transforms down to the node that lists it.
fn body_placements(tree: &[StepNode], count: usize) -> Vec<M4> {
    let mut out = vec![IDENTITY; count];
    fn walk(node: &StepNode, parent: &M4, out: &mut [M4]) {
        let m = mul(parent, &node.transform);
        for &b in &node.bodies { if b < out.len() { out[b] = m; } }
        for child in &node.children { walk(child, &m, out); }
    }
    for node in tree { walk(node, &IDENTITY, &mut out); }
    out
}

/// One meshed part: a distinct source item in the frame of its first placement.
struct Part { mesh: Mesh, placement_inverse: M4 }
impl Part {
    fn simplify(&mut self) {
        simplify_planar_faces(&self.mesh.positions, &mut self.mesh.triangles, &mut self.mesh.tri_face);
        self.mesh.face_count = self.mesh.tri_face.iter().copied().max().map_or(0, |f| f + 1);
    }
}
struct Mesh { positions: Vec<f64>, triangles: Vec<u32>, tri_face: Vec<u32>, face_count: u32, edge_offsets: Vec<u32>, edge_positions: Vec<f64>, edge_flags: Vec<u8> }

fn mesh_body(body: &ImportedBody, to_local: &M4, mode: u32) -> Option<Mesh> {
    let m = if mode & MODE_DISPLAY != 0 {
        body.body.display_mesh_angular((body.body.size() * CHORD_RATIO).max(CHORD_FLOOR_MM), ANGLE).ok()?
    } else {
        body.body.tessellate((body.body.size() * FACES_CHORD_RATIO).max(CHORD_FLOOR_MM)).ok()?
    };
    let mut positions = Vec::with_capacity(m.positions.len() * 3);
    for p in &m.positions { let q = apply(to_local, *p); positions.extend_from_slice(&[q[0] * MM, q[1] * MM, q[2] * MM]); }
    let mut triangles = Vec::with_capacity(m.triangles.len() * 3);
    for t in &m.triangles { triangles.extend_from_slice(t); }
    let mut tri_face = m.tri_face.clone();
    if mode & MODE_WELD != 0 { weld_and_drop_collapsed(&positions, &mut triangles, &mut tri_face); }
    let face_count = tri_face.iter().copied().max().map_or(0, |f| f + 1);
    let (mut edge_offsets, mut edge_positions, mut edge_flags) = (vec![0u32], Vec::new(), Vec::new());
    for (i, edge) in m.edges.iter().enumerate() {
        if edge.len() < 2 { continue; }
        for p in edge { let q = apply(to_local, *p); edge_positions.extend_from_slice(&[q[0] * MM, q[1] * MM, q[2] * MM]); }
        edge_offsets.push((edge_positions.len() / 3) as u32);
        let seam = m.seams.get(i).copied().unwrap_or(false);
        let smooth = m.smooth_edges.get(i).copied().unwrap_or(false);
        edge_flags.push(if seam { 3 } else if smooth { 2 } else { 0 });
    }
    if edge_flags.is_empty() { edge_offsets.clear(); }
    Some(Mesh { positions, triangles, tri_face, face_count, edge_offsets, edge_positions, edge_flags })
}

/// Weld vertices by position at the app's merge tolerance and drop the triangles that collapse to a line or point,
/// so the converter's own welding meets no triangle that folds over.
fn weld_and_drop_collapsed(positions: &[f64], triangles: &mut Vec<u32>, tri_face: &mut Vec<u32>) {
    let mut canonical = HashMap::<(i64, i64, i64), u32>::new();
    for t in 0..triangles.len() {
        let v = triangles[t] as usize;
        let key = ((positions[v * 3] / MERGE_TOL).round() as i64, (positions[v * 3 + 1] / MERGE_TOL).round() as i64, (positions[v * 3 + 2] / MERGE_TOL).round() as i64);
        let id = *canonical.entry(key).or_insert(triangles[t]);
        triangles[t] = id;
    }
    let (mut out_tris, mut out_faces) = (Vec::with_capacity(triangles.len()), Vec::with_capacity(tri_face.len()));
    for t in 0..triangles.len() / 3 {
        let (a, b, c) = (triangles[t * 3], triangles[t * 3 + 1], triangles[t * 3 + 2]);
        if a == b || b == c || a == c { continue; }
        out_tris.extend_from_slice(&[a, b, c]);
        out_faces.push(tri_face[t]);
    }
    *triangles = out_tris;
    *tri_face = out_faces;
}

/// Cosine of the angle within which facet normals count as one plane.
const PLANAR_COS: f64 = 0.999_999;
/// Sine of the turn below which a boundary vertex is collinear with its neighbours.
const COLLINEAR_SIN: f64 = 1e-6;

/// The kernel grids every flat face for shading; a flat face needs only the triangles of its outline, so each
/// planar source face is re-triangulated from the boundary of its facets (holes included). Boundary vertices that
/// lie straight between their neighbours on every face that uses them are dropped; one a curved face still needs
/// stays, so faces keep meeting edge to edge. A face whose boundary does not chain into loops keeps its facets.
fn simplify_planar_faces(positions: &[f64], triangles: &mut Vec<u32>, tri_face: &mut Vec<u32>) {
    let count = triangles.len() / 3;
    if count == 0 { return; }
    // The kernel meshes each face with vertices of its own, so faces that meet share positions, not indices.
    // Welding to one index per position lets the boundary rules below see every face a vertex belongs to.
    let mut canonical = HashMap::<(i64, i64, i64), u32>::new();
    for t in 0..triangles.len() {
        let v = triangles[t] as usize;
        let key = ((positions[v * 3] / MERGE_TOL).round() as i64, (positions[v * 3 + 1] / MERGE_TOL).round() as i64, (positions[v * 3 + 2] / MERGE_TOL).round() as i64);
        let id = *canonical.entry(key).or_insert(triangles[t]);
        triangles[t] = id;
    }
    let p = |v: u32| { let i = v as usize * 3; [positions[i], positions[i + 1], positions[i + 2]] };
    let sub = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let cross = |a: [f64; 3], b: [f64; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let norm = |a: [f64; 3]| { let l = dot(a, a).sqrt(); if l > 0.0 { [a[0] / l, a[1] / l, a[2] / l] } else { [0.0; 3] } };
    let faces = tri_face.iter().copied().max().map_or(0, |f| f as usize + 1);
    let mut by_face: Vec<Vec<usize>> = vec![Vec::new(); faces];
    for t in 0..count { by_face[tri_face[t] as usize].push(t); }
    // Pass 1: each face's plane and boundary loops, when it is flat and its boundary chains cleanly.
    struct Flat { normal: [f64; 3], loops: Vec<Vec<u32>> }
    let mut flats: Vec<Option<Flat>> = Vec::with_capacity(faces);
    for tris in &by_face {
        flats.push(None);
        if tris.len() < 2 { continue; }
        let mut normal = None;
        let mut planar = true;
        for &t in tris {
            let (a, b, c) = (p(triangles[t * 3]), p(triangles[t * 3 + 1]), p(triangles[t * 3 + 2]));
            let n = cross(sub(b, a), sub(c, a));
            if dot(n, n) == 0.0 { continue; }
            let n = norm(n);
            match normal { None => normal = Some(n), Some(first) => if dot(first, n) < PLANAR_COS { planar = false; break; } }
        }
        let (Some(normal), true) = (normal, planar) else { continue };
        let mut used = HashMap::<(u32, u32), u32>::new();
        for &t in tris { for k in 0..3 { *used.entry((triangles[t * 3 + k], triangles[t * 3 + (k + 1) % 3])).or_default() += 1; } }
        let mut next = HashMap::<u32, u32>::new();
        let mut ok = true;
        for (&(a, b), &n) in &used { if n == 1 && !used.contains_key(&(b, a)) && next.insert(a, b).is_some() { ok = false; break; } }
        if !ok || next.is_empty() { continue; }
        let mut loops: Vec<Vec<u32>> = Vec::new();
        while let Some((&start, _)) = next.iter().next() {
            let mut ring = vec![start];
            let mut at = start;
            loop {
                match next.remove(&at) { Some(b) => { if b == start { break; } ring.push(b); at = b; } None => { ok = false; break; } }
                if ring.len() > tris.len() * 3 { ok = false; break; }
            }
            if !ok { break; }
            if ring.len() >= 3 { loops.push(ring); }
        }
        if ok && !loops.is_empty() { *flats.last_mut().unwrap() = Some(Flat { normal, loops }); }
    }
    // Pass 2: a vertex may go when every face using it is flat and it lies straight on each of their boundaries.
    let vertex_count = positions.len() / 3;
    let mut users: Vec<Vec<u32>> = vec![Vec::new(); vertex_count];
    for t in 0..count { for k in 0..3 { let v = triangles[t * 3 + k] as usize; let f = tri_face[t]; if users[v].last() != Some(&f) { users[v].push(f); } } }
    let mut straight = vec![true; vertex_count];
    let mut on_boundary = vec![false; vertex_count];
    for flat in flats.iter().flatten() {
        for ring in &flat.loops {
            for (i, &v) in ring.iter().enumerate() {
                on_boundary[v as usize] = true;
                let (prev, nextv) = (p(ring[(i + ring.len() - 1) % ring.len()]), p(ring[(i + 1) % ring.len()]));
                let (a, b) = (sub(p(v), prev), sub(nextv, p(v)));
                let turn = cross(a, b);
                let collinear = dot(a, b) > 0.0 && dot(turn, turn).sqrt() <= COLLINEAR_SIN * dot(a, a).sqrt() * dot(b, b).sqrt();
                if !collinear { straight[v as usize] = false; }
            }
        }
    }
    let droppable = |v: u32| { let i = v as usize; on_boundary[i] && straight[i] && users[i].iter().all(|&f| flats[f as usize].is_some()) };
    // Pass 3: triangulate each flat face from its simplified loops.
    let (mut out_tris, mut out_faces) = (Vec::with_capacity(triangles.len()), Vec::with_capacity(tri_face.len()));
    for (face, tris) in by_face.iter().enumerate() {
        let keep = |out_tris: &mut Vec<u32>, out_faces: &mut Vec<u32>| for &t in tris { out_tris.extend_from_slice(&triangles[t * 3..t * 3 + 3]); out_faces.push(face as u32); };
        let Some(flat) = &flats[face] else { keep(&mut out_tris, &mut out_faces); continue; };
        let loops: Vec<Vec<u32>> = flat.loops.iter().map(|ring| ring.iter().copied().filter(|&v| !droppable(v)).collect()).filter(|ring: &Vec<u32>| ring.len() >= 3).collect();
        if loops.is_empty() { keep(&mut out_tris, &mut out_faces); continue; }
        let axis = if flat.normal[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
        let u = norm(cross(flat.normal, axis)); let v = cross(flat.normal, u);
        let origin = p(loops[0][0]);
        let project = |vertex: u32| { let d = sub(p(vertex), origin); [dot(d, u), dot(d, v)] };
        let area = |ring: &Vec<u32>| ring.iter().enumerate().map(|(i, &a)| { let (pa, pb) = (project(a), project(ring[(i + 1) % ring.len()])); pa[0] * pb[1] - pb[0] * pa[1] }).sum::<f64>() / 2.0;
        let mut loops = loops;
        loops.sort_by(|a, b| area(b).abs().partial_cmp(&area(a).abs()).unwrap_or(std::cmp::Ordering::Equal));
        let outer_ccw = area(&loops[0]) > 0.0;
        let (mut points, mut holes, mut order) = (Vec::new(), Vec::new(), Vec::new());
        for (i, ring) in loops.iter().enumerate() {
            if i > 0 { holes.push(order.len()); }
            for &vertex in ring { let q = project(vertex); points.push(q[0]); points.push(q[1]); order.push(vertex); }
        }
        let Ok(indices) = earcutr::earcut(&points, &holes, 2) else { keep(&mut out_tris, &mut out_faces); continue; };
        if indices.is_empty() || indices.len() / 3 > tris.len() { keep(&mut out_tris, &mut out_faces); continue; }
        let mut new_tris: Vec<[u32; 3]> = Vec::with_capacity(indices.len() / 3);
        for tri in indices.chunks(3) {
            let (a, b, c) = (order[tri[0]], order[tri[1]], order[tri[2]]);
            // The facets' winding is kept: earcut answers in the outline's own orientation.
            new_tris.push(if outer_ccw { [a, b, c] } else { [a, c, b] });
        }
        // Earcut leaves out outline vertices that lie straight between their neighbours. A neighbouring face still
        // uses them, so each goes back onto the triangle edge it lies on, dividing that triangle.
        let used: std::collections::HashSet<u32> = new_tris.iter().flatten().copied().collect();
        for &vertex in &order {
            if used.contains(&vertex) { continue; }
            let q = p(vertex);
            let found = new_tris.iter().enumerate().find_map(|(i, tri)| (0..3).find(|&k| on_segment(p(tri[k]), p(tri[(k + 1) % 3]), q)).map(|k| (i, k)));
            if let Some((i, k)) = found {
                let tri = new_tris[i];
                let (a, b, c) = (tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]);
                new_tris[i] = [a, vertex, c];
                new_tris.push([vertex, b, c]);
            }
        }
        for tri in new_tris { out_tris.extend_from_slice(&tri); out_faces.push(face as u32); }
    }
    *triangles = out_tris;
    *tri_face = out_faces;
}

/// Whether `q` lies strictly inside the segment `a`–`b`, within a hair of the line.
fn on_segment(a: [f64; 3], b: [f64; 3], q: [f64; 3]) -> bool {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let aq = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
    let len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    if len2 == 0.0 { return false; }
    let t = (aq[0] * ab[0] + aq[1] * ab[1] + aq[2] * ab[2]) / len2;
    if t <= 1e-9 || t >= 1.0 - 1e-9 { return false; }
    let off = [aq[0] - t * ab[0], aq[1] - t * ab[1], aq[2] - t * ab[2]];
    (off[0] * off[0] + off[1] * off[1] + off[2] * off[2]).sqrt() <= 1e-7 * len2.sqrt()
}

/// Layout: magic `PFSTEP01`; u32 part count; per part: name, closed, color (f32 rgb or -1), face_count, positions,
/// triangles, tri_face, edge_offsets, edge_positions, edge_flags; u32 placement count; per placement: part index,
/// name, instance name, path depth and names, 16 f64 column-major meters; then the warnings and header strings.
fn write_result(mut parts: Vec<Part>, placed: &[(usize, &ImportedBody, M4)], warnings: &[String], schema: &str, system: &str, mode: u32, threshold: u32) -> Vec<u8> {
    // Flat faces keep their facets below the threshold, where the app merges them into faces itself; above it the
    // parts stay meshes and every facet counts, so their flat faces are re-triangulated from their outlines.
    let placed_triangles: usize = placed.iter().map(|(part, _, _)| parts[*part].mesh.triangles.len() / 3).sum();
    if mode & MODE_DISPLAY != 0 && mode & MODE_SIMPLIFY != 0 && cfg!(feature = "simplify") && placed_triangles > threshold as usize {
        for part in &mut parts { part.simplify(); }
    }
    let mut w = Writer(Vec::new());
    w.0.extend_from_slice(b"PFSTEP01");
    w.u32(parts.len() as u32); w.pad();
    for (index, part) in parts.iter().enumerate() {
        let body = placed.iter().find(|(p, _, _)| *p == index).map(|(_, b, _)| *b).expect("part placed");
        w.text(&body.name);
        w.u32(body.closed as u32);
        match body.color { Some(c) => { w.f32(c[0]); w.f32(c[1]); w.f32(c[2]); } None => { w.f32(-1.0); w.f32(-1.0); w.f32(-1.0); } }
        w.u32(part.mesh.face_count); w.pad();
        w.f64s(&part.mesh.positions); w.u32s(&part.mesh.triangles); w.u32s(&part.mesh.tri_face);
        w.u32s(&part.mesh.edge_offsets); w.f64s(&part.mesh.edge_positions);
        w.u32(part.mesh.edge_flags.len() as u32); w.0.extend_from_slice(&part.mesh.edge_flags); w.pad();
        let _ = part.placement_inverse;
    }
    w.u32(placed.len() as u32); w.pad();
    for (part, body, matrix) in placed {
        w.u32(*part as u32);
        w.text(&body.name);
        w.text(body.instance.as_deref().unwrap_or(""));
        w.u32(body.path.len() as u32); w.pad();
        for name in &body.path { w.text(name); }
        for c in 0..4 { for r in 0..4 { w.f64(if r == 3 || c < 3 { matrix[c][r] } else { matrix[c][r] * MM }); } }
    }
    w.u32(warnings.len() as u32); w.pad();
    for warning in warnings { w.text(warning); }
    w.text(schema); w.text(system);
    w.0
}

// --- native entry point ------------------------------------------------------------------------

/// Read a STEP file natively: the reader converts its solids on the kernel's worker threads while the meshing threads
/// mesh each distinct part as soon as it is converted, and the result is the same buffer the wasm ABI produces.
/// `progress` is told the stage, the work done and the total; it may return false to cancel, which yields `Err`.
#[cfg(not(target_arch = "wasm32"))]
pub fn convert_native(text: &str, mode: u32, threshold: u32, mut progress: impl FnMut(&str, u32, u32) -> bool) -> Result<Vec<u8>, String> {
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(16);
    let mut r = Reading::open(text, mode, threshold, threads)?;
    let mut last = usize::MAX;
    loop {
        let more = r.step();
        let (done, total) = r.reading.as_ref().map_or((r.pipe.planned, r.pipe.planned), |reading| reading.progress());
        if done != last { last = done; if !progress("Converting parts", done as u32, total as u32) { return Err("cancelled".into()); } }
        if !more { break; }
    }
    r.finish()?;
    let total = r.pipe.planned as u32;
    loop {
        let done = (r.pipe.placed_done() as u32).min(total);
        if !progress("Meshing parts", done, total) { return Err("cancelled".into()); }
        if r.pipe.is_done() { break; }
        if r.pipe.threads == 0 { r.pipe.mesh_one(); } else { std::thread::sleep(std::time::Duration::from_millis(50)); }
    }
    let _ = progress("Meshing parts", total, total);
    r.result()
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    const BOX: &str = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t','',(''),(''),'','hand','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n";

    #[test]
    fn native_conversion_reports_progress_and_writes_the_result_magic() {
        // A file with no solids still parses; the result then holds zero parts.
        let text = format!("{BOX}#1=APPLICATION_CONTEXT('automotive design');\nENDSEC;\nEND-ISO-10303-21;\n");
        let mut stages = Vec::new();
        let result = super::convert_native(&text, 7, 0, |stage, done, total| { stages.push((stage.to_string(), done, total)); true });
        match result {
            Ok(bytes) => { assert_eq!(&bytes[..8], b"PFSTEP01"); assert!(stages.iter().any(|(s, _, _)| s == "Meshing parts")); }
            Err(e) => assert!(e.contains("no bodies") || e.contains("solids"), "{e}"),
        }
    }
}
