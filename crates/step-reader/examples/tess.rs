// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Compare the kernel's meshing calls on a box, a cylinder and a plate with a small hole: triangles per call.
use solidcraft_geom::Vec3;
fn main() {
    let b = solidcraft_kernel::box_solid(Vec3::new(0.0, 0.0, 0.0), Vec3::new(10.0, 10.0, 10.0)).unwrap();
    let c = solidcraft_kernel::cylinder(Vec3::new(0.0, 0.0, 0.0), Vec3::new(0.0, 0.0, 1.0), 5.0, 12.0).unwrap();
    let plate = solidcraft_kernel::box_solid(Vec3::new(0.0, 0.0, 0.0), Vec3::new(500.0, 500.0, 10.0)).unwrap();
    let pin = solidcraft_kernel::cylinder(Vec3::new(250.0, 250.0, -1.0), Vec3::new(0.0, 0.0, 1.0), 2.0, 12.0).unwrap();
    let holed = solidcraft_kernel::boolean(&plate, &pin, solidcraft_kernel::BoolOp::Cut).unwrap().unwrap();
    for (name, body) in [("box", &b), ("cylinder r5", &c), ("plate 500 with r2 hole", &holed)] {
        for ratio in [1e-3, 2e-3, 4e-3] {
            let tol = (body.size() * ratio).max(1e-3);
            let plain = body.tessellate(tol).unwrap();
            println!("{name}: ratio {ratio} tessellate {} tris, {} edges, seams {}, smooth {}", plain.triangles.len(), plain.edges.len(),
                plain.seams.iter().filter(|s| **s).count(), plain.smooth_edges.iter().filter(|s| **s).count());
        }
        for ratio in [1e-3, 4e-3, 1e-2, 3e-2] {
            let tol = (body.size() * ratio).max(1e-3);
            let angular = body.display_mesh_angular(tol, std::f64::consts::PI / 12.0).unwrap();
            let display = body.display_mesh(tol).unwrap();
            println!("{name}: ratio {ratio} display_mesh_angular {} tris, display_mesh {} tris", angular.triangles.len(), display.triangles.len());
        }
    }
}
