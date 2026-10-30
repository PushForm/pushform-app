// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocumentState, type LayoutViewport, type LayoutViewportCamera, type ModelReference } from './LayoutDocument';
import { layoutFrameSize, viewportCacheCurrent, viewportPaperPoint, viewportSourceKey } from './viewports';

const IN = 0.0254, MM = 25.4;
const m = (v: number[]) => v.map(x => x * IN) as [number, number, number];
const frame = (x: number, y: number, w: number, h: number) =>
  ([[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as [number, number][]).map(([u, v]) => [u * MM, v * MM] as [number, number]);

// A LayOut 2027 perspective viewport and the paper points LayOut's model_to_paper_point reported for it.
const perspective: LayoutViewportCamera = {
  eye: m([154.59745034414158, -67.97778598998778, 69.284067670143983]),
  target: m([53.169682725009132, 33.449981629144645, 18.570183860577771]),
  up: [-0.23570226039551587, 0.23570226039551587, 0.94280904158206347],
  projection: 'perspective', fov: 35, scale: 1,
};
const perspectiveFrame = frame(1.169291, 0.91557789, 3.8210192, 3.5650606);

describe('viewport projection', () => {
  it('matches LayOut for a perspective view', () => {
    const cases: [number[], [number, number]][] = [
      [[0, 0, 0], [1.060470834155707, 3.1220947203803733]],
      [[100, 0, 0], [3.5901382636030434, 4.663139055622702]],
      [[37, -58, 91], [-2.449209528918733, -0.9741922429332843]],
    ];
    for (const [model, paper] of cases) {
      const p = viewportPaperPoint(perspectiveFrame, perspective, m(model))!;
      expect(p[0] / MM).toBeCloseTo(paper[0], 6);
      expect(p[1] / MM).toBeCloseTo(paper[1], 6);
    }
  });

  it('matches LayOut for an off-center parallel view at 1:1', () => {
    // LayOut stored this as height 6.614 in, 2D zoom 0.714 and centers (0.0344, 0.1786); folded, the
    // frame center sits 0.2559 in right of and 0.5906 in above the view axis.
    const camera: LayoutViewportCamera = {
      eye: m([5.154586519391, 1.783954755886, 6794.019723671]), target: m([5.154586519391, 1.783954755886, 0]), up: [0, 1, 0],
      projection: 'parallel', fov: 30, scale: 1, shift: [0.25590944 * IN, 0.59055106 * IN],
    };
    const points = frame(0, 0.3937005, 10.62992, 4.72441);
    for (const [model, paper] of [[[0, 0, 0], [-0.09553496932663143, 5.13041086855196]], [[37, -58, 91], [36.904466160640645, 63.13041263985201]]] as const) {
      const p = viewportPaperPoint(points, camera, m([...model]))!;
      expect(p[0] / MM).toBeCloseTo(paper[0], 4);
      expect(p[1] / MM).toBeCloseTo(paper[1], 4);
    }
  });

  it('follows a rotated frame and rejects points behind the eye', () => {
    const [tl, tr, br, bl] = perspectiveFrame;
    const rotated = [bl!, tl!, tr!, br!].map(([x, y]) => [-y, x] as [number, number]);
    expect(layoutFrameSize(rotated).width).toBeCloseTo(3.5650606 * MM);
    expect(viewportPaperPoint(perspectiveFrame, perspective, m([500, -300, 120]))).toBeNull();
  });
});

describe('viewport render cache', () => {
  const viewport = (camera: LayoutViewportCamera, w: number, h: number): LayoutViewport => ({
    source: { archiveId: 'a', modelReferenceId: 'm' }, templateId: 'id1', originalId: 'id1', camera, scene: null, background: null,
    cache: { camera, widthMm: w, heightMm: h },
  });
  it('stays current for perspective frames scaled uniformly but not for resized parallel frames', () => {
    expect(viewportCacheCurrent(viewport(perspective, 100, 50), frame(0, 0, 200 / MM, 100 / MM))).toBe(true);
    expect(viewportCacheCurrent(viewport(perspective, 100, 50), frame(0, 0, 100 / MM, 100 / MM))).toBe(false);
    const parallel = { ...perspective, projection: 'parallel' as const, scale: 1 / 48 };
    expect(viewportCacheCurrent(viewport(parallel, 100, 50), frame(0, 0, 100 / MM, 50 / MM))).toBe(true);
    expect(viewportCacheCurrent(viewport(parallel, 100, 50), frame(0, 0, 200 / MM, 100 / MM))).toBe(false);
    expect(viewportCacheCurrent({ ...viewport(parallel, 100, 50), camera: { ...parallel, scale: 1 / 96 } }, frame(0, 0, 100 / MM, 50 / MM))).toBe(false);
  });
});

describe('cloud model sources', () => {
  const sha = 'a'.repeat(64), newer = 'b'.repeat(64);
  const withReference = () => {
    const state = createLayoutDocumentState();
    state.references.set(7, { id: 7, displayName: 'House', target: { kind: 'cloud', documentId: 'doc-1', revisionId: 'rev-1', revisionNumber: 1, sha256: sha, pinned: false } });
    return state;
  };
  const cloudView = (cache: LayoutViewport['cache']): LayoutViewport =>
    ({ source: { referenceId: 7 }, templateId: null, originalId: null, camera: perspective, scene: null, background: null, cache });

  it('keys a source by the embedded model, or by the cloud model at its referenced revision', () => {
    const state = withReference();
    expect(viewportSourceKey(state, { archiveId: 'a', modelReferenceId: 'm' })).toBe('a\u0000m');
    expect(viewportSourceKey(state, { referenceId: 7 })).toBe(`cloud\u0000doc-1\u0000${sha}`);
    state.references.get(7)!.target = { ...state.references.get(7)!.target as Extract<ModelReference['target'], { kind: 'cloud' }>, sha256: newer };
    expect(viewportSourceKey(state, { referenceId: 7 })).toBe(`cloud\u0000doc-1\u0000${newer}`);
    expect(viewportSourceKey(state, { referenceId: 8 })).toBe('cloud\u0000missing\u00008');
  });

  it('treats a cloud view picture as current only for the revision its reference now names', () => {
    const state = withReference(), points = frame(0, 0, 4, 2);
    const cache = { camera: perspective, widthMm: 4 * MM, heightMm: 2 * MM, sha256: sha };
    expect(viewportCacheCurrent(cloudView(cache), points, state)).toBe(true);
    expect(viewportCacheCurrent(cloudView({ ...cache, sha256: newer }), points, state)).toBe(false);
    expect(viewportCacheCurrent(cloudView({ camera: perspective, widthMm: 4 * MM, heightMm: 2 * MM }), points, state)).toBe(false);
    // Without the document, a cloud picture cannot be called current.
    expect(viewportCacheCurrent(cloudView(cache), points)).toBe(false);
    state.references.get(7)!.target = { ...state.references.get(7)!.target as Extract<ModelReference['target'], { kind: 'cloud' }>, sha256: newer };
    expect(viewportCacheCurrent(cloudView(cache), points, state)).toBe(false);
  });
});
