// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Material } from '@pushform/model';
import { applyAppearanceToneMapping, applyMaterialAppearance } from './appearance';
import { StudioEnvironment } from './StudioEnvironment';
import { TextureCache } from './TextureCache';

/** A small, demand-rendered studio. Never reads or rebuilds the document geometry. */
export class MaterialStudio {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 1, 0.01, 20);
  private readonly controls: OrbitControls;
  private readonly surface = new MeshStandardMaterial();
  private readonly sphere = new SphereGeometry(0.58, 48, 32);
  private readonly tile = new BoxGeometry(0.55, 0.55, 0.035);
  private readonly environment = new StudioEnvironment();
  private readonly textures = new TextureCache();
  private disposed = false;
  private generation = 0;
  constructor(
    canvas: HTMLCanvasElement,
    private readonly status: (status: string) => void,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    this.scene.background = new Color('#e9ede5');
    this.surface.onBeforeCompile = applyAppearanceToneMapping;
    this.surface.customProgramCacheKey = () => 'pf-material-studio-tone';
    const samples = new Group(),
      sphere = new Mesh(this.sphere, this.surface),
      tile = new Mesh(this.tile, this.surface);
    sphere.position.x = -0.29;
    tile.position.set(0.65, -0.05, 0);
    tile.rotation.set(-0.25, -0.25, -0.12);
    samples.add(sphere, tile);
    this.scene.add(samples);
    const key = new DirectionalLight(0xffffff, 2);
    key.position.set(-2, 3, 4);
    this.scene.add(key);
    this.environment.apply(this.scene, this.renderer, undefined, 0, 1, () => this.draw());
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.minDistance = 2.3;
    this.controls.maxDistance = 6;
    this.controls.addEventListener('change', this.draw);
    this.textures.onLoad = this.draw;
    this.reset();
  }
  readonly draw = (): void => {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  };
  resize(width: number): void {
    this.camera.aspect = Math.max(1, width) / 160;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(Math.max(1, width), 160, false);
    this.draw();
  }
  reset(): void {
    this.camera.position.set(0, 0.25, 3.4);
    this.controls.target.set(0.1, 0, 0);
    this.controls.update();
    this.draw();
  }
  rotate(direction: number): void {
    this.camera.position.applyAxisAngle(this.camera.up, (direction * Math.PI) / 12);
    this.controls.update();
  }
  setMaterial(material: Material, colorUrl?: string, normalUrl?: string): void {
    const generation = ++this.generation,
      s = this.surface,
      previousMap = s.map,
      previousNormal = s.normalMap;
    applyMaterialAppearance(s, material.appearance);
    s.color.copy(colorUrl ? new Color('#ffffff') : new Color().setRGB(...material.color, 'srgb'));
    s.opacity = material.alpha;
    s.transparent = material.alpha < 1;
    s.map = colorUrl ? this.textures.get(colorUrl) : null;
    s.normalMap = normalUrl ? this.textures.normal(normalUrl) : null;
    if (s.map !== previousMap || s.normalMap !== previousNormal) s.needsUpdate = true;
    const urls = [colorUrl, normalUrl].filter((url): url is string => !!url);
    const tile = material.texture ?? material.appearance?.normal;
    for (const map of [s.map, s.normalMap])
      if (map) map.repeat.set(0.55 / (tile?.widthM ?? 1), 0.55 / (tile?.heightM ?? 1));
    this.textures.prune(new Set(urls));
    this.draw();
    this.status(urls.length ? 'Loading preview' : '');
    void this.textures.whenReady(10_000, urls).then(
      () => {
        if (!this.disposed && generation === this.generation) {
          this.status('');
          this.draw();
        }
      },
      () => {
        if (!this.disposed && generation === this.generation)
          this.status('An image could not load. Showing the available surface.');
      },
    );
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.controls.dispose();
    this.environment.dispose();
    this.textures.dispose();
    this.sphere.dispose();
    this.tile.dispose();
    this.surface.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
