// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  EquirectangularReflectionMapping,
  PMREMGenerator,
  SRGBColorSpace,
  TextureLoader,
} from 'three';
import type { Scene, WebGLRenderer, WebGLRenderTarget } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** One prefiltered environment per viewport, built lazily and reused across every material and frame. */
export class StudioEnvironment {
  private studio: WebGLRenderTarget | null = null;
  private image: WebGLRenderTarget | null = null;
  private url: string | undefined;
  private generation = 0;
  private disposed = false;
  private loading: Promise<void> = Promise.resolve();
  get ready(): Promise<void> {
    return this.loading;
  }
  apply(
    scene: Scene,
    renderer: WebGLRenderer,
    url: string | undefined,
    rotation: number,
    intensity: number,
    redraw: () => void,
  ): void {
    if (!this.studio) {
      const generator = new PMREMGenerator(renderer),
        room = new RoomEnvironment();
      try {
        this.studio = generator.fromScene(room, 0.04);
      } finally {
        room.dispose();
        generator.dispose();
      }
    }
    scene.environment = this.image?.texture ?? this.studio.texture;
    scene.environmentIntensity = intensity;
    // Environment images are Y-up equirectangular; the model is Z-up.
    scene.environmentRotation.set(Math.PI / 2, 0, rotation);
    if (url === this.url) return;
    this.url = url;
    const generation = ++this.generation;
    this.image?.dispose();
    this.image = null;
    scene.environment = this.studio.texture;
    if (!url) {
      this.loading = Promise.resolve();
      return;
    }
    this.loading = new Promise((resolve) =>
      new TextureLoader().load(
        url,
        (texture) => {
          if (this.disposed || generation !== this.generation) {
            texture.dispose();
            resolve();
            return;
          }
          texture.mapping = EquirectangularReflectionMapping;
          texture.colorSpace = SRGBColorSpace;
          const generator = new PMREMGenerator(renderer);
          try {
            this.image = generator.fromEquirectangular(texture);
          } finally {
            texture.dispose();
            generator.dispose();
          }
          scene.environment = this.image.texture;
          redraw();
          resolve();
        },
        undefined,
        () => {
          resolve();
          redraw();
        },
      ),
    );
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.studio?.dispose();
    this.image?.dispose();
  }
}
