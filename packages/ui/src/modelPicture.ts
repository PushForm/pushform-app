// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DocumentState, ImageStore } from '@pushform/model';
import { Viewport, studioLight, studioLightLevels, type CameraState } from '@pushform/render';
import { STUDIO_LIGHTING } from '@pushform/core';
import { environmentPreset } from '@pushform/model';
import { withRenderImageStore, bodiesToRender, sketchesToRender, imagesToRender, dimensionsToRender, textsToRender, guidesToRender } from './engine/renderAdapter';
import { sectionsToRender } from './engine/sectionAdapter';
import { applyDocumentView } from './engine/viewSync';

export interface ModelPictureOptions {
  width: number; height: number; background?: string;
  camera?: CameraState;
  lighting?: 'document' | 'camera' | 'soft' | 'bright';
  isometric?: boolean;
}
/** Shared offscreen model rendering. Presentation overrides never mutate the saved document. */
export async function modelPicture(state: DocumentState, images: ImageStore, options: ModelPictureOptions): Promise<HTMLCanvasElement | null> {
  await document.fonts?.ready;
  const viewport = new Viewport();
  try {
    if (!viewport.mountOffscreen()) return null;
    withRenderImageStore(images, () => { viewport.setBodies(bodiesToRender(state)); viewport.setSketches(sketchesToRender(state)); });
    viewport.setImages(imagesToRender(state, images)); viewport.setSections(sectionsToRender(state));
    viewport.setDimensions(dimensionsToRender(state)); viewport.setTexts(textsToRender(state)); viewport.setGuides(guidesToRender(state));
    applyDocumentView(viewport, state, images);
    if (options.lighting && options.lighting !== 'document') {
      viewport.setShadows({ ...viewport.shadows, enabled: false, useSunForShading: false });
      viewport.setEnvironment(options.lighting === 'bright' || options.lighting === 'soft' ? environmentPreset(options.lighting) : null, []);
    }
    viewport.camera.setSize(options.width, options.height);
    if (options.camera) viewport.camera.setState(options.camera);
    else {
      if (options.isometric) {
        const bounds = viewport.sceneSync.sceneBounds();
        if (bounds) {
          const target = bounds.min.map((n, i) => (n + bounds.max[i]!) / 2) as [number, number, number];
          const size = bounds.max.map((n, i) => n - bounds.min[i]!);
          const h = (size[0]! + size[1]!) / Math.sqrt(6) + size[2]! * Math.sqrt(2 / 3);
          const w = (size[0]! + size[1]!) / Math.sqrt(2);
          const distance = Math.max(...size, 1) * 3;
          viewport.camera.setState({ eye: [target[0] + distance, target[1] - distance, target[2] + distance], target, up: [0,0,1], projection: 'parallel', fov: 35,
            orthoHeight: Math.max(h, w * options.height / options.width, .001) / .8 });
        }
      } else viewport.camera.zoomExtents();
    }
    await Promise.all([viewport.sceneSync.textures.whenReady(), viewport.environmentReady]);
    await Promise.all([viewport.sceneSync.dimensions.ready, viewport.sceneSync.texts.prepare(), viewport.sceneSync.sections.ready]);
    const before = studioLight.value, levels = studioLightLevels.value.clone();
    try {
      studioLight.value = options.lighting === 'soft' || options.lighting === 'bright' ? 1 : 0;
      if (options.lighting === 'soft' || options.lighting === 'bright') { const p = STUDIO_LIGHTING[options.lighting]; studioLightLevels.value.set(p.ambient, p.facing, p.key); }
      const picture = document.createElement('canvas');
      const environmentBackground = options.background === undefined && (options.lighting === undefined || options.lighting === 'document') && !!state.styles.get(state.activeStyleId)?.environment;
      return viewport.snapshotInto(picture, options.width, options.height, viewport.camera.getState(), { background: options.background ?? '#ffffff', environmentBackground }) ? picture : null;
    } finally { studioLight.value = before; studioLightLevels.value.copy(levels); }
  } finally { const renderer = viewport.renderer; viewport.dispose(); renderer?.forceContextLoss(); }
}
