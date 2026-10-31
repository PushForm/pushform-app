// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREVIEW_VIEW, normalizePreview, parsePreviewMesh, PREVIEW_BYTE_LIMIT, PREVIEW_TRIANGLE_LIMIT, projectPreview, previewSvg, stlPreview } from './CommonsPreview';
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
