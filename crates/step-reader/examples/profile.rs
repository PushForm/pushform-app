// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Profile a STEP file natively: the slowest conversion steps and the slowest bodies to mesh, with what their faces are.
use std::collections::BTreeMap;
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("usage: profile FILE.step");
    let text = std::fs::read_to_string(&path).expect("read");
    let t = Instant::now();
    let mut reading = solidcraft_kernel::StepReading::new(&text).expect("parse");
    eprintln!("parsed in {} ms", t.elapsed().as_millis());
    let mut slow = Vec::new();
    loop {
        let (before, _) = reading.progress();
        let s = Instant::now();
        if !reading.step() { break; }
        let (after, total) = reading.progress();
        let ms = s.elapsed().as_millis();
        if ms > 1000 { slow.push((ms, before, after, total)); }
    }
    for (ms, before, after, total) in &slow { eprintln!("step converting {}..{} of {} took {} ms", before, after, total, ms); }
    let import = reading.finish().expect("finish");
    eprintln!("converted in {} ms: {} bodies", t.elapsed().as_millis(), import.bodies.len());
    let mut timings: Vec<(u128, usize)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (i, body) in import.bodies.iter().enumerate() {
        if !seen.insert(body.source_item) { continue; }
        let s = Instant::now();
        let tol = (body.body.size() * 4e-3).max(1e-3);
        let _ = body.body.display_mesh_angular(tol, std::f64::consts::PI / 12.0);
        timings.push((s.elapsed().as_millis(), i));
    }
    eprintln!("meshed in {} ms", t.elapsed().as_millis());
    timings.sort_by(|a, b| b.0.cmp(&a.0));
    // The slowest body under each meshing call the kernel offers.
    if let Some((_, i)) = timings.first() {
        let body = &import.bodies[*i].body;
        let tol = (body.size() * 4e-3).max(1e-3);
        for (name, run) in [
            ("display_mesh_angular 15°", Box::new(|| body.display_mesh_angular(tol, std::f64::consts::PI / 12.0)) as Box<dyn Fn() -> solidcraft_kernel::Result<solidcraft_geom::Mesh>>),
            ("display_mesh_angular 20°", Box::new(|| body.display_mesh_angular(tol, std::f64::consts::PI / 9.0))),
            ("display_mesh", Box::new(|| body.display_mesh(tol))),
            ("tessellate", Box::new(|| body.tessellate(tol))),
            ("tessellate 1e-3", Box::new(|| body.tessellate((body.size() * 1e-3).max(1e-3)))),
        ] {
            let s = Instant::now();
            match run() { Ok(m) => eprintln!("  slowest body with {name}: {} ms, {} triangles", s.elapsed().as_millis(), m.triangles.len()), Err(e) => eprintln!("  slowest body with {name}: failed {e}") }
        }
    }
    for (ms, i) in timings.iter().take(4) {
        let body = &import.bodies[*i];
        let faces = body.body.face_count();
        let mut kinds: BTreeMap<&'static str, usize> = BTreeMap::new();
        for f in 0..faces {
            let kind = match solidcraft_kernel::face_surface(&body.body, f) {
                Some(solidcraft_kernel::FaceSurface::Plane { .. }) => "plane",
                Some(solidcraft_kernel::FaceSurface::Cylinder { .. }) => "cylinder",
                Some(solidcraft_kernel::FaceSurface::Cone { .. }) => "cone",
                Some(_) => "other analytic",
                None => "free-form",
            };
            *kinds.entry(kind).or_default() += 1;
        }
        eprintln!("body {} '{}' (item {}): mesh {} ms, size {:.1} mm, {} faces, closed {}: {:?}", i, body.name, body.source_item, ms, body.body.size(), faces, body.closed, kinds);
    }
}
