//! PushForm: a body from planar polygon faces.
//!
//! PushForm's geometry is a triangle mesh with a face layer, so a face is a polygon (an outline
//! and holes) over shared vertices. This builds the kernel body those faces make: vertices
//! shared by index, one straight edge per pair of neighbouring vertices, one wire per loop, one
//! planar face per polygon, all in one shell. A shell that closes is a solid (oriented
//! outward); any other is a surface body, which STEP writes as a shell-based surface model.

use std::collections::HashMap;

use solidcraft_geom::Vec3;
use truck_modeling::{self as mt, builder};

use crate::body::{Body, Solid, p3};
use crate::record::Rebuild;
use crate::{KernelError, Result, guard};

/// Most faces and vertices one body is built from.
const MAX_FACES: usize = 2_000_000;

/// A planar face: its outline and holes as loops of indices into the vertex list. The outline
/// runs counter-clockwise about the face's outward normal; hole winding is corrected here.
#[derive(Clone, Debug, PartialEq)]
pub struct PolygonFace {
    pub outline: Vec<usize>,
    pub holes: Vec<Vec<usize>>,
}

/// The loop's area vector (Newell): twice its area along the normal it runs counter-clockwise about.
fn area_vector(vertices: &[Vec3], loop_: &[usize]) -> Vec3 {
    let mut sum = Vec3::ZERO;
    for (k, &a) in loop_.iter().enumerate() {
        let (Some(&p), Some(&q)) = (vertices.get(a), loop_.get((k + 1) % loop_.len()).and_then(|&b| vertices.get(b))) else { continue };
        sum = sum + p.cross(q);
    }
    sum
}

/// The body of `faces` over `vertices` (mm). Errors for a loop with fewer than three distinct
/// vertices, an index out of range, or faces that cannot lie on a plane.
pub fn body_from_polygons(vertices: &[Vec3], faces: &[PolygonFace]) -> Result<Body> {
    if faces.is_empty() {
        return Err(KernelError::Invalid("no faces to build a body from".into()));
    }
    if faces.len() > MAX_FACES || vertices.len() > MAX_FACES * 4 {
        return Err(KernelError::Invalid("too many faces for one body".into()));
    }
    if vertices.iter().any(|v| !v.is_finite()) {
        return Err(KernelError::Invalid("a vertex is not finite".into()));
    }
    guard("polygon faces", || {
        let tv: Vec<mt::Vertex> = vertices.iter().map(|v| builder::vertex(p3(*v))).collect();
        let mut edges: HashMap<(usize, usize), mt::Edge> = HashMap::new();
        let mut wire_of = |loop_: &[usize], flip: bool| -> Result<mt::Wire> {
            let n = loop_.len();
            if n < 3 || loop_.iter().any(|&i| i >= tv.len()) {
                return Err(KernelError::Invalid("a face loop needs three vertices in range".into()));
            }
            let mut wire = Vec::with_capacity(n);
            for k in 0..n {
                let (a, b) = (loop_[k], loop_[(k + 1) % n]);
                if a == b {
                    return Err(KernelError::Invalid("a face loop repeats a vertex".into()));
                }
                let key = (a.min(b), a.max(b));
                let e = edges.entry(key).or_insert_with(|| builder::line(&tv[key.0], &tv[key.1])).clone();
                wire.push(if a < b { e } else { e.inverse() });
            }
            let mut wire: mt::Wire = wire.into();
            if flip {
                wire.invert();
            }
            Ok(wire)
        };
        let mut out = Vec::with_capacity(faces.len());
        for f in faces {
            let sum = area_vector(vertices, &f.outline);
            let n = sum.normalized().ok_or_else(|| KernelError::Invalid("a face has no area".into()))?;
            let mut wires = vec![wire_of(&f.outline, false)?];
            for h in &f.holes {
                // Holes run clockwise about the outward normal.
                wires.push(wire_of(h, area_vector(vertices, h).dot(n) > 0.0)?);
            }
            out.push(builder::try_attach_plane(&wires).map_err(|e| KernelError::Failed(format!("polygon face: {e}")))?);
        }
        let shell = mt::Shell::from(out);
        if shell.shell_condition() == mt::ShellCondition::Closed
            && let Ok(solid) = Solid::try_new(vec![shell.clone()])
        {
            return Body::new(solid);
        }
        crate::surfaces::body_of(shell.face_iter().cloned().collect(), &[], &Rebuild::default())
    })
}
