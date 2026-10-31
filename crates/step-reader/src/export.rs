// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! STEP writing for PushForm: the app sends its parts as polygon faces over shared vertices, with their
//! placements, names and colours, and gets back the Part 21 text. SolidCraft's kernel sews each part into a body
//! (`body_from_polygons`) and writes the product structure (`step_export_products`).
//!
//! The request is one little-endian buffer (no alignment), lengths in meters; strings are a `u32` byte length and
//! UTF-8. The file is written in millimeters, as the kernel does.
//!
//! ```text
//! magic "PFSTEPX1"
//! header: file_name, time_stamp, author, organization, description (strings)
//! root: u32 (the top product)
//! products: u32 count, each:
//!   name (string)
//!   parts: u32 count, each: name (string), colour u8 (0 none, 1 follows) [f32 r, g, b, 0..1], opacity f32,
//!     vertices u32 count + 3 × f64 each, faces u32 count, each: colour u8 (0 none, 1 follows) [f32 r, g, b, opacity],
//!     loops u32 count (the outline first, then holes), each loop: u32 count + u32 vertex indices
//!   children: u32 count, each: product u32, matrix 16 × f64 (by columns, translation last), name (string)
//! ```

use solidcraft_geom::Vec3;
use solidcraft_kernel::{Body, FacePaint, Paint, ExportBody, ExportProduct, PolygonFace, StepHeader, body_from_polygons, step_export_products};

const MAGIC: &[u8; 8] = b"PFSTEPX1";
/// Meters to the file's millimeters.
const TO_MM: f64 = 1000.0;
/// Most products, parts, and children one request lists, so a damaged buffer cannot ask for gigabytes.
const MAX_ITEMS: usize = 5_000_000;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(n).filter(|e| *e <= self.bytes.len()).ok_or("the export request is cut short")?;
        let s = &self.bytes[self.at..end];
        self.at = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().map_err(|_| "bad u32")?))
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().map_err(|_| "bad f32")?))
    }
    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().map_err(|_| "bad f64")?))
    }
    /// A count, refused when the bytes left cannot hold that many items of `min` bytes.
    fn count(&mut self, min: usize) -> Result<usize, String> {
        let n = self.u32()? as usize;
        if n > MAX_ITEMS || n.saturating_mul(min) > self.bytes.len() - self.at {
            return Err("the export request lists more than it holds".into());
        }
        Ok(n)
    }
    fn string(&mut self) -> Result<String, String> {
        let n = self.count(1)?;
        Ok(String::from_utf8_lossy(self.take(n)?).into_owned())
    }
}

struct Part {
    name: String,
    color: Option<[f32; 3]>,
    opacity: f32,
    /// Faces with a colour of their own: (face, colour, opacity).
    painted: Vec<FacePaint>,
    vertices: Vec<Vec3>,
    faces: Vec<PolygonFace>,
}

struct Product {
    name: String,
    parts: Vec<Part>,
    children: Vec<(usize, [[f64; 4]; 4], String)>,
}

fn parse(bytes: &[u8]) -> Result<(StepHeader, usize, Vec<Product>), String> {
    let mut r = Reader { bytes, at: 0 };
    if r.take(8)? != MAGIC {
        return Err("not a PushForm export request".into());
    }
    let header = StepHeader {
        file_name: r.string()?,
        time_stamp: r.string()?,
        author: r.string()?,
        organization: r.string()?,
        description: r.string()?,
    };
    let root = r.u32()? as usize;
    let mut products = Vec::new();
    for _ in 0..r.count(4)? {
        let name = r.string()?;
        let mut parts = Vec::new();
        for _ in 0..r.count(4)? {
            let name = r.string()?;
            let color = if r.u8()? == 1 { Some([r.f32()?, r.f32()?, r.f32()?]) } else { None };
            let opacity = r.f32()?;
            let mut painted = Vec::new();
            let mut vertices = Vec::new();
            for _ in 0..r.count(24)? {
                vertices.push(Vec3::new(r.f64()? * TO_MM, r.f64()? * TO_MM, r.f64()? * TO_MM));
            }
            let mut faces = Vec::new();
            for face in 0..r.count(4)? {
                if r.u8()? == 1 {
                    painted.push(FacePaint { face, color: [r.f32()?, r.f32()?, r.f32()?], opacity: r.f32()? });
                }
                let mut loops = Vec::new();
                for _ in 0..r.count(4)? {
                    let mut l = Vec::new();
                    for _ in 0..r.count(4)? {
                        l.push(r.u32()? as usize);
                    }
                    loops.push(l);
                }
                let mut it = loops.into_iter();
                let outline = it.next().ok_or("a face has no outline")?;
                faces.push(PolygonFace { outline, holes: it.collect() });
            }
            parts.push(Part { name, color, opacity, painted, vertices, faces });
        }
        let mut children = Vec::new();
        for _ in 0..r.count(4)? {
            let child = r.u32()? as usize;
            let mut m = [[0.0; 4]; 4];
            for (c, column) in m.iter_mut().enumerate() {
                for cell in column.iter_mut() {
                    *cell = r.f64()?;
                }
                if c == 3 {
                    column.iter_mut().take(3).for_each(|x| *x *= TO_MM);
                }
            }
            children.push((child, m, r.string()?));
        }
        products.push(Product { name, parts, children });
    }
    if root >= products.len() {
        return Err("the export request names no top product".into());
    }
    Ok((header, root, products))
}

/// Write the STEP text for a request. `progress` is told the parts built so far and their total, and may return
/// false to cancel, which yields `Err("cancelled")`.
pub fn export_step(request: &[u8], mut progress: impl FnMut(u32, u32) -> bool) -> Result<String, String> {
    let (header, root, products) = parse(request)?;
    let total = products.iter().map(|p| p.parts.len()).sum::<usize>() as u32;
    let mut bodies: Vec<Vec<Body>> = Vec::new();
    let mut done = 0;
    for p in &products {
        let mut made = Vec::new();
        for part in &p.parts {
            if !progress(done, total) {
                return Err("cancelled".into());
            }
            let mut body = body_from_polygons(&part.vertices, &part.faces).map_err(|e| format!("{}: {e}", part.name))?;
            if part.opacity < 1.0 || !part.painted.is_empty() {
                body = body.with_paint(Some(Paint { opacity: part.opacity, faces: part.painted.clone() }));
            }
            made.push(body);
            done += 1;
        }
        bodies.push(made);
    }
    if !progress(total, total) {
        return Err("cancelled".into());
    }
    let list: Vec<ExportProduct> = products
        .iter()
        .zip(&bodies)
        .map(|(p, made)| ExportProduct {
            name: p.name.clone(),
            bodies: p.parts.iter().zip(made).map(|(part, body)| ExportBody { name: part.name.clone(), body, color: part.color }).collect(),
            children: p.children.clone(),
        })
        .collect();
    step_export_products(&list, root, &header).map_err(|e| e.to_string())
}

thread_local! {
    static RESULT: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Write the STEP text for the request at `ptr` (`pf_alloc`). Returns the text's length, or 0 on failure (`pf_error_*`
/// has the reason); `pf_step_export_ptr` then points at the text, which stays until the next export.
///
/// # Safety
/// `ptr` and `len` must describe readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_step_export(ptr: *const u8, len: u32) -> u32 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    match export_step(bytes, |_, _| true) {
        Ok(text) => RESULT.with(|r| {
            *r.borrow_mut() = text.into_bytes();
            r.borrow().len() as u32
        }),
        Err(e) => crate::fail(e),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn pf_step_export_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}
