// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! `Math.sin`, `Math.cos`, `Math.atan2` and `x ** 3` as V8 on ARM64 computes them, so operations that build geometry
//! from them give the same numbers on every engine and build. A platform's own sine or cosine differs in the last digit
//! on some inputs, which is enough to renumber faces.
//!
//! The code is V8's port of fdlibm. V8's ARM64 builds compile it with clang's default fused multiply-add contraction, so
//! the calls to `mul_add` below sit exactly where clang fuses an expression; x86-64 builds of V8 differ from these in
//! the last bit. Checked against Node 24 on ARM64 over four million inputs with no mismatch. The fdlibm notice follows
//! (see also `crates/native-kernel/NOTICE.md`):
//!
//! Developed at SunPro, a Sun Microsystems, Inc. business.
//! Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice
//! is preserved.

const NPIO2_HW: [i32; 32] = [
  0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB,
  0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C, 0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
];
const INVPIO2: f64 = f64::from_bits(0x3FE4_5F30_6DC9_C883);
const PIO2_1: f64 = f64::from_bits(0x3FF9_21FB_5440_0000);
const PIO2_1T: f64 = f64::from_bits(0x3DD0_B461_1A62_6331);
const PIO2_2: f64 = f64::from_bits(0x3DD0_B461_1A60_0000);
const PIO2_2T: f64 = f64::from_bits(0x3BA3_198A_2E03_7073);
const PIO2_3: f64 = f64::from_bits(0x3BA3_198A_2E00_0000);
const PIO2_3T: f64 = f64::from_bits(0x397B_839A_2520_49C1);

fn high_word(x: f64) -> i32 {
  (x.to_bits() >> 32) as u32 as i32
}

/// `__ieee754_rem_pio2`: the remainder of `x` by pi/2 in `y[0] + y[1]` and the quadrant.
fn rem_pio2(x: f64, y: &mut [f64; 2]) -> i32 {
  let hx = high_word(x);
  let ix = hx & 0x7FFF_FFFF;
  if ix <= 0x3FE921FB {
    y[0] = x;
    y[1] = 0.0;
    return 0;
  }
  if ix < 0x4002D97C {
    if hx > 0 {
      let mut z = x - PIO2_1;
      if ix != 0x3FF921FB {
        y[0] = z - PIO2_1T;
        y[1] = (z - y[0]) - PIO2_1T;
      } else {
        z -= PIO2_2;
        y[0] = z - PIO2_2T;
        y[1] = (z - y[0]) - PIO2_2T;
      }
      return 1;
    }
    let mut z = x + PIO2_1;
    if ix != 0x3FF921FB {
      y[0] = z + PIO2_1T;
      y[1] = (z - y[0]) + PIO2_1T;
    } else {
      z += PIO2_2;
      y[0] = z + PIO2_2T;
      y[1] = (z - y[0]) + PIO2_2T;
    }
    return -1;
  }
  // The kernel only takes the sine or cosine of an angle within a few turns, far inside this medium range; a huge
  // argument (fdlibm's Payne-Hanek reduction, not ported) cannot reach here.
  assert!(ix <= 0x413921FB, "angle outside the range the kernel uses");
  let mut t = x.abs();
  let n = t.mul_add(INVPIO2, 0.5) as i32;
  let fnn = f64::from(n);
  let mut r = (-fnn).mul_add(PIO2_1, t);
  let mut w = fnn * PIO2_1T;
  if n < 32 && ix != NPIO2_HW[(n - 1) as usize] {
    y[0] = r - w;
  } else {
    let j = ix >> 20;
    y[0] = r - w;
    let high = high_word(y[0]);
    let mut i = j - ((high >> 20) & 0x7FF);
    if i > 16 {
      t = r;
      w = fnn * PIO2_2;
      r = t - w;
      w = fnn.mul_add(PIO2_2T, -((t - r) - w));
      y[0] = r - w;
      let high = high_word(y[0]);
      i = j - ((high >> 20) & 0x7FF);
      if i > 49 {
        t = r;
        w = fnn * PIO2_3;
        r = t - w;
        w = fnn.mul_add(PIO2_3T, -((t - r) - w));
        y[0] = r - w;
      }
    }
  }
  y[1] = (r - y[0]) - w;
  if hx < 0 {
    y[0] = -y[0];
    y[1] = -y[1];
    -n
  } else {
    n
  }
}

/// `__kernel_sin`.
fn kernel_sin(x: f64, y: f64, iy: i32) -> f64 {
  const S1: f64 = -1.66666666666666324348e-01;
  const S2: f64 = 8.33333333332248946124e-03;
  const S3: f64 = -1.98412698298579493134e-04;
  const S4: f64 = 2.75573137070700676789e-06;
  const S5: f64 = -2.50507602534068634195e-08;
  const S6: f64 = 1.58969099521155010221e-10;
  let ix = high_word(x) & 0x7FFF_FFFF;
  if ix < 0x3E40_0000 && (x as i32) == 0 {
    return x;
  }
  let z = x * x;
  let v = z * x;
  let r = z.mul_add(z.mul_add(z.mul_add(z.mul_add(S6, S5), S4), S3), S2);
  if iy == 0 {
    v.mul_add(z.mul_add(r, S1), x)
  } else {
    // `0.5 * y - v * r` fuses its first product, `z * (...) - y` and the final `... - v * S1` fuse theirs.
    let q = 0.5_f64.mul_add(y, -(v * r));
    let u = z.mul_add(q, -y);
    x - ((-v).mul_add(S1, u))
  }
}

/// `__kernel_cos`.
fn kernel_cos(x: f64, y: f64) -> f64 {
  const C1: f64 = 4.16666666666666019037e-02;
  const C2: f64 = -1.38888888888741095749e-03;
  const C3: f64 = 2.48015872894767294178e-05;
  const C4: f64 = -2.75573143513906633035e-07;
  const C5: f64 = 2.08757232129817482790e-09;
  const C6: f64 = -1.13596475577881948265e-11;
  let ix = high_word(x) & 0x7FFF_FFFF;
  if ix < 0x3E40_0000 && (x as i32) == 0 {
    return 1.0;
  }
  let z = x * x;
  let r = z * z.mul_add(z.mul_add(z.mul_add(z.mul_add(z.mul_add(C6, C5), C4), C3), C2), C1);
  let term = z.mul_add(r, -(x * y));
  if ix < 0x3FD3_3333 {
    1.0 - (0.5 * z - term)
  } else {
    let qx = if ix > 0x3FE9_0000 { 0.28125 } else { f64::from_bits(u64::from((ix - 0x0020_0000) as u32) << 32) };
    let iz = 0.5_f64.mul_add(z, -qx);
    let a = 1.0 - qx;
    a - (iz - term)
  }
}

/// `Math.sin(x)`.
pub fn sin(x: f64) -> f64 {
  let ix = high_word(x) & 0x7FFF_FFFF;
  if ix <= 0x3FE921FB {
    return kernel_sin(x, 0.0, 0);
  }
  if ix >= 0x7FF0_0000 {
    return x - x;
  }
  let mut y = [0.0, 0.0];
  match rem_pio2(x, &mut y) & 3 {
    0 => kernel_sin(y[0], y[1], 1),
    1 => kernel_cos(y[0], y[1]),
    2 => -kernel_sin(y[0], y[1], 1),
    _ => -kernel_cos(y[0], y[1]),
  }
}

/// `Math.cos(x)`.
pub fn cos(x: f64) -> f64 {
  let ix = high_word(x) & 0x7FFF_FFFF;
  if ix <= 0x3FE921FB {
    return kernel_cos(x, 0.0);
  }
  if ix >= 0x7FF0_0000 {
    return x - x;
  }
  let mut y = [0.0, 0.0];
  match rem_pio2(x, &mut y) & 3 {
    0 => kernel_cos(y[0], y[1]),
    1 => -kernel_sin(y[0], y[1], 1),
    2 => -kernel_cos(y[0], y[1]),
    _ => kernel_sin(y[0], y[1], 1),
  }
}

fn atan(x_in: f64) -> f64 {
  const ATANHI: [f64; 4] = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
  const ATANLO: [f64; 4] = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
  const AT: [f64; 11] = [
    3.33333333333329318027e-01,
    -1.99999999998764832476e-01,
    1.42857142725034663711e-01,
    -1.11111104054623557880e-01,
    9.09088713343650656196e-02,
    -7.69187620504482999495e-02,
    6.66107313738753120669e-02,
    -5.83357013379057348645e-02,
    4.97687799461593236017e-02,
    -3.65315727442169155270e-02,
    1.62858201153657823623e-02,
  ];
  let mut x = x_in;
  let hx = high_word(x);
  let ix = hx & 0x7FFF_FFFF;
  if ix >= 0x4410_0000 {
    if x.is_nan() {
      return x + x;
    }
    return if hx > 0 { ATANHI[3] + ATANLO[3] } else { -ATANHI[3] - ATANLO[3] };
  }
  let id: i32;
  if ix < 0x3FDC_0000 {
    if ix < 0x3E20_0000 && 1.0e300 + x > 1.0 {
      return x;
    }
    id = -1;
  } else {
    x = x.abs();
    if ix < 0x3FF3_0000 {
      if ix < 0x3FE6_0000 {
        id = 0;
        x = (2.0 * x - 1.0) / (2.0 + x);
      } else {
        id = 1;
        x = (x - 1.0) / (x + 1.0);
      }
    } else if ix < 0x4003_8000 {
      id = 2;
      x = (x - 1.5) / 1.5_f64.mul_add(x, 1.0);
    } else {
      id = 3;
      x = -1.0 / x;
    }
  }
  let z = x * x;
  let w = z * z;
  let s1 = z * w.mul_add(w.mul_add(w.mul_add(w.mul_add(w.mul_add(AT[10], AT[8]), AT[6]), AT[4]), AT[2]), AT[0]);
  let s2 = w * w.mul_add(w.mul_add(w.mul_add(w.mul_add(AT[9], AT[7]), AT[5]), AT[3]), AT[1]);
  if id < 0 {
    (-x).mul_add(s1 + s2, x)
  } else {
    let z = ATANHI[id as usize] - (x.mul_add(s1 + s2, -ATANLO[id as usize]) - x);
    if hx < 0 { -z } else { z }
  }
}

/// `Math.atan2(y, x)`.
pub fn atan2(y: f64, x: f64) -> f64 {
  const TINY: f64 = 1.0e-300;
  const PI_O_4: f64 = f64::from_bits(0x3FE9_21FB_5444_2D18);
  const PI_O_2: f64 = f64::from_bits(0x3FF9_21FB_5444_2D18);
  const PI: f64 = f64::from_bits(0x4009_21FB_5444_2D18);
  const PI_LO: f64 = f64::from_bits(0x3CA1_A626_3314_5C07);
  if x.is_nan() || y.is_nan() {
    return x + y;
  }
  let (hx, lx) = (high_word(x), x.to_bits() as u32);
  let (hy, ly) = (high_word(y), y.to_bits() as u32);
  let (ix, iy) = (hx & 0x7FFF_FFFF, hy & 0x7FFF_FFFF);
  if hx.wrapping_sub(0x3FF0_0000) == 0 && lx == 0 {
    return atan(y);
  }
  let mut m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
  if iy == 0 && ly == 0 {
    return match m {
      0 | 1 => y,
      2 => PI + TINY,
      _ => -PI - TINY,
    };
  }
  if ix == 0 && lx == 0 {
    return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
  }
  if ix == 0x7FF0_0000 {
    if iy == 0x7FF0_0000 {
      return match m {
        0 => PI_O_4 + TINY,
        1 => -PI_O_4 - TINY,
        2 => 3.0 * PI_O_4 + TINY,
        _ => -3.0 * PI_O_4 - TINY,
      };
    }
    return match m {
      0 => 0.0,
      1 => -0.0,
      2 => PI + TINY,
      _ => -PI - TINY,
    };
  }
  if iy == 0x7FF0_0000 {
    return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
  }
  let k = (iy - ix) >> 20;
  let mut z;
  if k > 60 {
    z = PI_O_2 + 0.5 * PI_LO;
    m &= 1;
  } else if hx < 0 && k < -60 {
    z = 0.0;
  } else {
    z = atan((y / x).abs());
  }
  match m {
    0 => z,
    1 => -z,
    2 => PI - (z - PI_LO),
    _ => {
      z = z - PI_LO;
      z - PI
    }
  }
}

/// `x ** 3` for the Bezier parameters of a domed knob's profile, where V8 gives the correctly rounded cube.
/// `x * x * x` rounds twice and is a bit off on about a fifth of those values, so the cube carries the low part of each
/// product along (exact for the 109 values that occur, see the test).
pub fn cube(x: f64) -> f64 {
  let square = x * x;
  let square_error = x.mul_add(x, -square);
  let product = square * x;
  let product_error = square.mul_add(x, -product);
  product + (product_error + square_error * x)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sine_and_cosine_match_v8_on_sample_angles() {
    // Values captured from Node on these exact inputs, as bit patterns so nothing is lost in printing.
    use std::f64::consts::PI;
    let samples: [(f64, u64, u64); 8] = [
      (PI / 6.0, 0x3fdf_ffff_ffff_ffff, 0x3feb_b67a_e858_4cab),
      (PI / 8.0, 0x3fd8_7de2_a6ae_a963, 0x3fed_906b_cf32_8d46),
      (PI / 2.0, 0x3ff0_0000_0000_0000, 0x3c91_a626_3314_5c07),
      (3.0 * PI / 2.0, 0xbff0_0000_0000_0000, 0xbcaa_7939_4c9e_8a0a),
      (0.5, 0x3fde_aee8_744b_05f0, 0x3fec_1528_065b_7d50),
      (5.123, 0xbfed_570e_a162_c784, 0x3fd9_8bfe_c920_aa2a),
      (0.7, 0x3fe4_9d6e_6946_19b8, 0x3fe8_7996_529f_9d93),
      (3.0 * 2.0 * PI / 7.0, 0x3fdb_c4c0_4d71_abc3, 0xbfec_d4bc_a9cb_5c70),
    ];
    for (x, s, c) in samples {
      assert_eq!(sin(x).to_bits(), s, "sin({x})");
      assert_eq!(cos(x).to_bits(), c, "cos({x})");
    }
  }

  #[test]
  fn atan2_matches_v8_on_sample_and_special_cases() {
    assert_eq!(atan2(0.0, 1.0).to_bits(), 0x0000_0000_0000_0000);
    assert_eq!(atan2(-0.0, 1.0).to_bits(), 0x8000_0000_0000_0000);
    assert_eq!(atan2(1.0, 0.0).to_bits(), 0x3ff9_21fb_5444_2d18);
    assert_eq!(atan2(1.0, 1.0).to_bits(), 0x3fe9_21fb_5444_2d18);
    assert_eq!(atan2(0.0, -1.0).to_bits(), 0x4009_21fb_5444_2d18);
    assert_eq!(atan2(0.3, -0.7).to_bits(), 0x4005_e4c3_6ca0_118a);
    assert_eq!(atan2(-2.5, 3.25).to_bits(), 0xbfe4_fb75_64da_cded);
    assert_eq!(atan2(1.0, 1.5).to_bits(), 0x3fe2_d0ea_d606_6395);
  }

  #[test]
  fn cube_matches_v8_on_every_domed_profile_parameter() {
    // `x ** 3` from Node for each parameter a domed knob's profile can reach (every `i / count` and `1 - i / count`, for
    // the counts 2 to 16 that 8 to 32 profile segments split into), as bit patterns, in ascending order of x.
    const CUBES: [u64; 109] = [
      0x3f30_0000_0000_0000, 0x3f33_6b06_e70b_741d, 0x3f33_6b06_e70b_7421, 0x3f37_e225_515a_4f14,
      0x3f37_e225_515a_4f1c, 0x3f3d_d46b_aab4_9c13, 0x3f3d_d46b_aab4_9c25, 0x3f42_f684_bda1_2f67,
      0x3f42_f684_bda1_2f6f, 0x3f48_9e7c_3fdb_1246, 0x3f48_9e7c_3fdb_124d, 0x3f50_624d_d2f1_a9f9,
      0x3f50_624d_d2f1_a9fd, 0x3f56_7980_e0bf_08c6, 0x3f56_7980_e0bf_08d0, 0x3f60_0000_0000_0000,
      0x3f63_6b06_e70b_741d, 0x3f63_6b06_e70b_7421, 0x3f67_e225_515a_4f1c, 0x3f67_e225_515a_4f24,
      0x3f6d_d46b_aab4_9c25, 0x3f72_f684_bda1_2f65, 0x3f72_f684_bda1_2f67, 0x3f78_9e7c_3fdb_1240,
      0x3f78_9e7c_3fdb_1246, 0x3f7b_0000_0000_0000, 0x3f80_624d_d2f1_a9f9, 0x3f80_624d_d2f1_a9fd,
      0x3f84_26cf_7ca4_32c0, 0x3f84_26cf_7ca4_32c2, 0x3f86_7980_e0bf_08c6, 0x3f89_2b3a_d808_63ba,
      0x3f89_2b3a_d808_63bf, 0x3f90_0000_0000_0000, 0x3f93_6b06_e70b_7421, 0x3f93_6b06_e70b_7424,
      0x3f94_c5b8_d5e0_d769, 0x3f97_e225_515a_4f1c, 0x3f9b_a5e3_53f7_ced8, 0x3f9b_a5e3_53f7_cedd,
      0x3f9d_d46b_aab4_9c25, 0x3f9f_4000_0000_0000, 0x3fa2_f684_bda1_2f67, 0x3fa2_f684_bda1_2f6a,
      0x3fa7_52d8_7172_3140, 0x3fa7_52d8_7172_3143, 0x3fa8_9e7c_3fdb_1246, 0x3fab_0000_0000_0000,
      0x3fad_2171_24b4_6079, 0x3fad_2171_24b4_607c, 0x3fb0_624d_d2f1_a9fd, 0x3fb2_84bd_a12f_684a,
      0x3fb2_84bd_a12f_684d, 0x3fb4_26cf_7ca4_32c0, 0x3fb4_26cf_7ca4_32c2, 0x3fb5_7000_0000_0000,
      0x3fb6_7980_e0bf_08c6, 0x3fb8_0ac5_565b_efd7, 0x3fb8_0ac5_565b_efda, 0x3fb9_2b3a_d808_63bf,
      0x3fba_0466_3f90_5899, 0x3fc0_0000_0000_0000, 0x3fc3_6b06_e70b_7421, 0x3fc3_fbce_20db_fe99,
      0x3fc4_c5b8_d5e0_d769, 0x3fc5_f2a7_db7a_8e94, 0x3fc6_c800_0000_0000, 0x3fc7_e225_515a_4f1c,
      0x3fc9_684b_da12_f682, 0x3fc9_684b_da12_f686, 0x3fcb_a5e3_53f7_ced8, 0x3fcd_d46b_aab4_9c25,
      0x3fcf_4000_0000_0000, 0x3fd0_7e2c_3cc7_42bd, 0x3fd1_00bf_112a_8ad1, 0x3fd1_00bf_112a_8ad4,
      0x3fd2_f684_bda1_2f67, 0x3fd2_f684_bda1_2f6a, 0x3fd4_cc00_0000_0000, 0x3fd5_3c79_a647_1428,
      0x3fd5_f3b6_45a1_cabf, 0x3fd7_52d8_7172_3143, 0x3fd8_9e7c_3fdb_1246, 0x3fd9_3d5d_38d0_2330,
      0x3fd9_3d5d_38d0_2334, 0x3fdb_0000_0000_0000, 0x3fdd_2171_24b4_6079, 0x3fdd_2171_24b4_607c,
      0x3fde_1ccb_ad1f_f4c4, 0x3fdf_0b32_017e_2255, 0x3fe0_624d_d2f1_a9fd, 0x3fe1_2a00_0000_0000,
      0x3fe1_86d3_f475_b5c1, 0x3fe1_86d3_f475_b5c3, 0x3fe2_84bd_a12f_684d, 0x3fe3_62ed_7911_20fa,
      0x3fe4_26cf_7ca4_32c0, 0x3fe4_26cf_7ca4_32c2, 0x3fe4_d4b0_479a_a975, 0x3fe5_7000_0000_0000,
      0x3fe6_7980_e0bf_08c6, 0x3fe7_53f7_ced9_1688, 0x3fe8_0ac5_565b_efd7, 0x3fe8_a5ed_097b_425e,
      0x3fe9_2b3a_d808_63bf, 0x3fe9_9ef9_4865_811f, 0x3fea_0466_3f90_5899, 0x3fea_5e00_0000_0000,
      0x3ff0_0000_0000_0000,
    ];
    let mut values = std::collections::BTreeSet::new();
    for count in 2..=16 {
      for i in 1..=count {
        let t = f64::from(i) / f64::from(count);
        values.insert(t.to_bits());
        values.insert((1.0 - t).to_bits());
      }
    }
    values.remove(&0);
    assert_eq!(values.len(), CUBES.len());
    for (bits, expected) in values.iter().zip(CUBES) {
      let x = f64::from_bits(*bits);
      assert_eq!(cube(x).to_bits(), expected, "x = {x}");
    }
    assert_eq!(cube(0.0).to_bits(), 0);
  }
}
