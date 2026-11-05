// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREVIEW_VIEW, rasterPreview, normalizePreview, parsePreviewMesh, PREVIEW_BYTE_LIMIT, PREVIEW_TRIANGLE_LIMIT, projectPreview, previewSvg, stlPreview } from './CommonsPreview';
const ascii = (vertices = 'vertex 0 0 0\nvertex 10 0 0\nvertex 0 10 10') => new TextEncoder().encode(`solid test\nfacet normal 0 0 1\nouter loop\n${vertices}\nendloop\nendfacet\nendsolid test`);
describe('geometry display derivatives', () => {
  it('renders actual ASCII geometry and changes its projection when orbiting or zooming', () => {
    const mesh = stlPreview(ascii()); expect(mesh.positions).toEqual([-.5,-.5,-.5,.5,-.5,-.5,-.5,.5,.5]);
    const initial = projectPreview(mesh); expect(initial).toHaveLength(1);
    expect(projectPreview(mesh, { ...DEFAULT_PREVIEW_VIEW, yaw: 1 })).not.toEqual(initial);
    expect(projectPreview(mesh, { ...DEFAULT_PREVIEW_VIEW, zoom: 2 })).not.toEqual(initial);
    expect(previewSvg(mesh)).toContain('<polygon points='); expect(parsePreviewMesh(mesh)).toEqual(mesh);
  });
  it('reads binary STL even when the header begins with solid', () => {
    const bytes = new Uint8Array(134); bytes.set(new TextEncoder().encode('solid binary'));
    const data = new DataView(bytes.buffer); data.setUint32(80,1,true);
    [0,0,0,10,0,0,0,10,10].forEach((v,i) => data.setFloat32(96+i*4,v,true));
    expect(stlPreview(bytes)).toEqual(stlPreview(ascii()));
  });
  it('rejects corrupt, non-finite, empty and degenerate geometry', () => {
    for (const bytes of [ascii('vertex 0 0 0'), ascii('vertex NaN 0 0\nvertex 1 0 0\nvertex 0 1 0'), ascii('vertex 0 0 0\nvertex 1 1 1\nvertex 2 2 2'),new TextEncoder().encode('solid empty\nendsolid empty'),new Uint8Array([1,2,3])]) expect(() => stlPreview(bytes)).toThrow();
  });
  it('rejects oversized sources and excessive triangle counts before allocation', () => {
    expect(() => stlPreview(new Uint8Array(PREVIEW_BYTE_LIMIT+1))).toThrow('8 MiB');
    const bytes = new Uint8Array(84 + (PREVIEW_TRIANGLE_LIMIT+1)*50);new DataView(bytes.buffer).setUint32(80,PREVIEW_TRIANGLE_LIMIT+1,true);
    expect(() => stlPreview(bytes)).toThrow('12,000');
  });
  it('rejects unsafe or unbounded mesh responses', () => {
    for (const positions of [[],[0],[Infinity,...Array(8).fill(0)],[1,...Array(8).fill(0)],Array(PREVIEW_TRIANGLE_LIMIT*9+9).fill(0)]) expect(() => parsePreviewMesh({version:1,positions})).toThrow();
  });
});

it('keeps per-triangle material colors through normalization and rejects invalid color data',()=>{
 const mesh=normalizePreview([0,0,0,10,0,0,0,10,10],[1,0,0]);expect(parsePreviewMesh(mesh).colors).toEqual([1,0,0]);expect(projectPreview(mesh)[0]!.fill).toMatch(/^rgb\(\d+,0,0\)$/);
 expect(()=>parsePreviewMesh({...mesh,colors:[1,0]})).toThrow();expect(()=>normalizePreview([0,0,0,1,0,0,0,1,0],[2,0,0])).toThrow();
});

it('draws nearer surfaces over farther ones and outlines only real edges', () => {
  // Two squares facing the viewer, the nearer one smaller and drawn first: depth decides, not drawing order.
  const square = (half: number, z: number, split: boolean) => split
    ? [-half, -half, z, half, -half, z, half, half, z, -half, -half, z, half, half, z, -half, half, z]
    : [-half, -half, z, half, -half, z, -half, half, z, half, -half, z, half, half, z, -half, half, z];
  const view = { yaw: 0, pitch: -Math.PI / 2, zoom: 1 };
  const mesh = normalizePreview([...square(.2, -1, true), ...square(.5, 0, false)], [1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1]);
  const pixels = rasterPreview(mesh, view, { width: 120, height: 100, supersample: 1, edgeWidth: 1 });
  const at = (x: number, y: number) => Array.from(pixels.subarray((y * 120 + x) * 4, (y * 120 + x) * 4 + 3));
  const centre = at(60, 50), side = at(35, 50);
  expect(centre[0]).toBeGreaterThan(centre[2]!);
  expect(side[2]).toBeGreaterThan(side[0]!);
  // The diagonal seam between the near square's two triangles is not outlined.
  expect(at(55, 45)).toEqual(at(65, 55));
});


it('projects the front-right-top isometric basis with Z up and correct near-face depth', () => {
  const mesh = { version: 1 as const, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] };
  const face = projectPreview(mesh)[0]!;
  const points = face.points.split(' ').map(point => point.split(',').map(Number));
  const origin = points[0]!, x = points[1]!, y = points[2]!;
  // +X goes down-right; +Y goes up-right. Front (-Y) and right (+X) face the camera.
  expect(x[0]! - origin[0]!).toBeCloseTo(265 / Math.sqrt(2), 1);
  expect(y[0]! - origin[0]!).toBeCloseTo(265 / Math.sqrt(2), 1);
  expect(x[1]! - origin[1]!).toBeCloseTo(265 / Math.sqrt(6), 1);
  expect(y[1]! - origin[1]!).toBeCloseTo(-265 / Math.sqrt(6), 1);
  expect(face.depth).toBeCloseTo(0);
  const raised = projectPreview({ ...mesh, positions: mesh.positions.map((n, i) => i % 3 === 2 ? n + 1 : n) })[0]!;
  expect(raised.depth - face.depth).toBeCloseTo(Math.sqrt(3));
  const translated = (axis: number, amount: number) => projectPreview({ ...mesh, positions: mesh.positions.map((n, i) => i % 3 === axis ? n + amount : n) })[0]!.depth;
  expect(translated(0, 1)).toBeGreaterThan(face.depth);
  expect(translated(1, -1)).toBeGreaterThan(face.depth);
});


it('rasterizes the front, right and top faces of an asymmetric-colored cube in the same isometric view', () => {
  const corners = [[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5],[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]];
  const positions: number[] = [], colors: number[] = [];
  const faces = [[0,1,5,4], [1,2,6,5], [4,5,6,7], [2,3,7,6], [3,0,4,7], [0,3,2,1]];
  faces.forEach((face, index) => {
    for (const triangle of [[0,1,2], [0,2,3]]) {
      for (const vertex of triangle) positions.push(...corners[face[vertex]!]!);
      colors.push(...(index === 0 ? [1,0,0] : index === 1 ? [0,1,0] : index === 2 ? [0,0,1] : [1,1,0]));
    }
  });
  const pixels = rasterPreview({ version: 1, positions, colors }, undefined, { width: 120, height: 100, fit: true });
  for (const [x,y,channel] of [[36,64,0], [84,64,1], [60,22,2]]) {
    const rgb = pixels.slice((y! * 120 + x!) * 4, (y! * 120 + x!) * 4 + 3);
    expect(rgb[channel!]!).toBeGreaterThan(50);
    expect([...rgb].filter((_, i) => i !== channel)).toEqual([0,0]);
  }
});
