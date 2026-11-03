// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { LayoutEntity } from '@pushform/layout';
import { LAYOUT_VIEW_EMPTY, LAYOUT_VIEW_FAILED, layoutImageReady, layoutImageState, paintLayoutImage, prepareLayoutImages } from './layoutImage';
import { LayoutVectorRecorder } from './layoutVectorDrawing';

const camera = { eye: [10, -10, 10] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number],
  projection: 'perspective' as const, fov: 35, scale: 1 };
function modelView(background: string | null = null): LayoutEntity {
  return { id: 1, kind: 'image', layerId: 1, closed: true, points: [[0, 0], [100, 0], [100, 50], [0, 50]],
    image: { src: '', viewport: { source: { archiveId: 'a', modelReferenceId: 'm' }, templateId: 't', originalId: null, camera, scene: null, background, cache: null } } };
}
/** What painting the view with this picture records: each filled or stroked path's colors. */
function painted(entity: LayoutEntity, src: string): { fill: string | null; stroke: string | null }[] {
  const recorder = new LayoutVectorRecorder(null);
  paintLayoutImage(recorder as unknown as CanvasRenderingContext2D, entity, false, src);
  return recorder.items.map(item => item.kind === 'path' ? { fill: item.fill, stroke: item.stroke } : { fill: null, stroke: null });
}

describe('model view pictures', () => {
  it('shows the loading placeholder while a view has no picture yet', () => {
    expect(painted(modelView(), '')).toEqual([{ fill: '#eef1f5', stroke: null }]);
  });

  it('paints nothing for an empty view, or only its background, and treats it as ready to print', async () => {
    expect(painted(modelView(), LAYOUT_VIEW_EMPTY)).toEqual([]);
    expect(painted(modelView('#ffeedd'), LAYOUT_VIEW_EMPTY)).toEqual([{ fill: '#ffeedd', stroke: null }]);
    expect(layoutImageState(LAYOUT_VIEW_EMPTY)).toBe('empty');
    expect(layoutImageReady(LAYOUT_VIEW_EMPTY)).toBe(true);
    await expect(prepareLayoutImages([modelView()], () => LAYOUT_VIEW_EMPTY)).resolves.toBeUndefined();
  });

  it('paints nothing but the background in print and export for a view without a picture, failed or not', () => {
    const paint = (entity: LayoutEntity, src: string) => {
      const recorder = new LayoutVectorRecorder(null);
      paintLayoutImage(recorder as unknown as CanvasRenderingContext2D, entity, false, src, true);
      return recorder.items.map(item => item.kind === 'path' ? item.fill : null);
    };
    for (const src of ['', LAYOUT_VIEW_EMPTY, LAYOUT_VIEW_FAILED]) {
      expect(paint(modelView(), src)).toEqual([]);
      expect(paint(modelView('#ffeedd'), src)).toEqual(['#ffeedd']);
    }
    // A plain picture that has not loaded keeps its placeholder; printing waits for it or reports it.
    const picture: LayoutEntity = { ...modelView(), image: { src: 'not-loaded.png' } };
    expect(paint(picture, 'not-loaded.png')).toEqual(['#eef1f5']);
  });

  it('marks a view that could not be rendered with a gray box crossed in red in the workspace, also over its background', async () => {
    const marker = [{ fill: '#c8c8c8', stroke: null }, { fill: null, stroke: '#d81e1e' }];
    expect(painted(modelView(), LAYOUT_VIEW_FAILED)).toEqual(marker);
    expect(painted(modelView('#ffeedd'), LAYOUT_VIEW_FAILED)).toEqual([{ fill: '#ffeedd', stroke: null }, ...marker]);
    expect(layoutImageState(LAYOUT_VIEW_FAILED)).toBe('failed');
    // Printing is not held up by a view that cannot be rendered; the marker prints instead.
    await expect(prepareLayoutImages([modelView()], () => LAYOUT_VIEW_FAILED)).resolves.toBeUndefined();
  });
});
