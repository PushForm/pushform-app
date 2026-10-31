// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Emitter } from '@pushform/core';
import type { Box3, MeshData, Ray, Vec2, Vec3, Mat4 } from '@pushform/core';
import type { CameraState, OverlayPrimitive } from '@pushform/commands';
import { Color, DirectionalLight, Fog, HemisphereLight, Raycaster, Scene, Vector2, Vector3, WebGLRenderer } from 'three';
import type { Mesh, BufferGeometry } from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { BufferGeometry as ThreeBufferGeometry, Mesh as ThreeMesh } from 'three';
import { CameraController } from './camera/CameraController';
import { DEFAULT_CAMERA, worldPerPixelAtDepth, cameraForward } from './camera/CameraState';
import { OverlayLayer } from './overlay/OverlayLayer';
import { Axes } from './scene/Axes';
import { GroundGrid } from './scene/GroundGrid';
import { DEFAULT_RENDER_BACKGROUND, SkyBackground } from './scene/SkyBackground';
import type { RenderBackground } from './types';
import { SceneSync } from './SceneSync';
import type { EdgeStyle } from './SceneSync';
import type { HighlightState, RenderAxes, RenderBody, RenderDimensions, RenderDisplay, RenderEditContext, RenderGuides, RenderImage, RenderSections, RenderSketch, RenderTexts } from './types';
import { DEFAULT_RENDER_FOG, DEFAULT_RENDER_SHADOWS } from './types';
import type { RenderFog, RenderShadows } from './types';
import { SunLight } from './shadows/SunLight';
import { shadowDisplay } from './renderables/BodyRenderable';

// three-mesh-bvh acceleration for CPU picking.
(ThreeBufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
(ThreeBufferGeometry.prototype as unknown as { disposeBoundsTree: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;
(ThreeMesh.prototype as unknown as { raycast: typeof acceleratedRaycast }).raycast = acceleratedRaycast;

export interface ViewportEvents extends Record<string, unknown> {
  resize: { width: number; height: number };
  render: undefined;
  cursorHint: { text: string; screen: Vec2 | null } | null;
  cameraChanged: CameraState;
}

/** Offscreen snapshot settings (`Viewport.snapshot`). */
export interface SnapshotOptions {
  shift?: readonly [number, number] | undefined;
  background: string | null;
}

/** 2D graphic export settings (`Viewport.renderImage`). */
export interface ImageOptions {
  readonly antialias: boolean;
  readonly transparent: boolean;
}

export interface ViewportOptions {
  readonly camera?: CameraState;
  readonly background?: number;
  /** Draw the ground plane grid; off unless asked for. */
  readonly grid?: boolean;
}

/**
 * Owns the WebGLRenderer, scenes, lights, ground/axes, SceneSync, OverlayLayer and the
 * CameraController. The renderer is created lazily in `mount()` so the Viewport can be
 * constructed without a DOM (tests, headless bootstrap).
 */
export class Viewport {
  readonly events = new Emitter<ViewportEvents>();
  readonly scene = new Scene();
  readonly sceneSync = new SceneSync();
  readonly overlay = new OverlayLayer();
  readonly camera: CameraController;
  readonly grid: GroundGrid;
  readonly axes: Axes;
  private readonly sky: SkyBackground;
  /** Sun light + shadow map + ground shadow plane (wraps the key and hemisphere lights). */
  readonly sunLight: SunLight;
  private fogSettings: RenderFog = DEFAULT_RENDER_FOG;
  private shadowSettings: RenderShadows = DEFAULT_RENDER_SHADOWS;
  renderer: WebGLRenderer | null = null;
  container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private frame: number | null = null;
  private width = 1;
  private height = 1;
  private overlayPrims: readonly OverlayPrimitive[] = [];
  private raycaster = new Raycaster();
  private lastCursorHint: string | null = null;

  constructor(opts: ViewportOptions = {}) {
    this.camera = new CameraController(opts.camera ?? DEFAULT_CAMERA, {
      pick: (s) => this.pick(s),
      sceneBounds: () => this.sceneSync.sceneBounds(),
    });
    this.camera.events.on('changed', (s) => {
      this.events.emit('cameraChanged', s);
      this.requestRender();
    });
    this.scene.background = new Color(opts.background ?? 0xe9eef4);
    this.sceneSync.setBackgroundColor(opts.background ?? 0xe9eef4);
    const hemi = new HemisphereLight(0xffffff, 0x9aa5b1, 1.1);
    hemi.position.set(0, 0, 1);
    const sun = new DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.6, -0.45, 1).normalize();
    this.scene.add(hemi, sun, this.sceneSync.root);
    // Redraw when a texture image finished loading (materials agent).
    this.sceneSync.textures.onLoad = () => this.requestRender();
    this.grid = new GroundGrid();
    this.grid.visible = opts.grid ?? false;
    this.axes = new Axes();
    this.scene.add(this.grid, this.axes);
    this.sky = new SkyBackground(DEFAULT_RENDER_BACKGROUND);
    this.scene.add(this.sky);
    this.scene.background = null;
    this.sunLight = new SunLight(sun, hemi);
    this.scene.add(this.sunLight.ground, sun.target);
  }

  /** Current sun/shadow settings. */
  get shadows(): RenderShadows {
    return this.shadowSettings;
  }

  /**
   * Sun and shadows: direction (NOAA solar position computed by the adapter), Light/Dark
   * intensities, the PCF soft shadow map (`renderer.shadowMap`), the ground shadow plane and
   * whether faces receive shadows ("On Faces"). Solid and sheet face meshes cast/receive per their entity flags.
   */
  setShadows(settings: RenderShadows): void {
    this.shadowSettings = settings;
    const onFacesChanged = shadowDisplay.onFaces !== settings.onFaces;
    shadowDisplay.onFaces = settings.onFaces;
    this.sunLight.set(settings, this.renderer);
    // Shade where the sun does not reach: 0.2 plus Dark.
    this.sceneSync.setSunShade(settings.enabled && settings.onFaces ? Math.min(1, 0.2 + Math.max(0, settings.dark) / 100) : null);
    if (onFacesChanged) {
      for (const m of this.sceneSync.faceMeshes()) m.receiveShadow = settings.onFaces && m.userData['receiveShadows'] !== false;
    }
    this.sunLight.fit(this.sceneSync.sceneBounds());
    this.requestRender();
  }

  get fog(): RenderFog {
    return this.fogSettings;
  }

  /** Linear fog between `near` and `far` meters from the eye; `enabled: false` removes it. */
  setFog(settings: RenderFog): void {
    this.fogSettings = settings;
    this.sky.setFog(settings);
    if (!settings.enabled || settings.far <= 0) {
      this.scene.fog = null;
    } else {
      const far = Math.max(settings.far, settings.near + 0.01);
      const fog = this.scene.fog instanceof Fog ? this.scene.fog : new Fog(0xffffff, settings.near, far);
      fog.color.set(settings.color);
      fog.near = settings.near;
      fog.far = far;
      this.scene.fog = fog;
    }
    this.requestRender();
  }

  /**
   * Render the current view into a `width × height` PNG data URL (scene thumbnails). Resolves to
   * '' without a mounted renderer (tests, headless). The main canvas is drawn synchronously after
   * a render, so no `preserveDrawingBuffer` is needed.
   */
  captureThumbnail(width = 160, height = 100): Promise<string> {
    const renderer = this.renderer;
    if (!renderer || typeof document === 'undefined') return Promise.resolve('');
    try {
      this.render();
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return Promise.resolve('');
      const src = renderer.domElement;
      const sw = src.width, sh = src.height;
      const scale = Math.max(canvas.width / Math.max(1, sw), canvas.height / Math.max(1, sh));
      const dw = sw * scale, dh = sh * scale;
      ctx.drawImage(src, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
      return Promise.resolve(canvas.toDataURL('image/png'));
    } catch {
      return Promise.resolve('');
    }
  }

  /**
   * Render into a canvas that is never shown (Layout viewports). Returns false where WebGL is
   * unavailable. The canvas keeps its drawing buffer so `snapshot` can read it back.
   */
  mountOffscreen(): boolean {
    if (this.renderer) return true;
    if (typeof document === 'undefined') return false;
    try {
      const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, stencil: true, canvas: document.createElement('canvas') });
      renderer.setPixelRatio(1);
      // Section cuts clip per object and fill through the stencil buffer.
      renderer.localClippingEnabled = true;
      this.renderer = renderer;
      this.sunLight.configureRenderer(renderer);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Render `camera` into a `width × height` pixel PNG data URL with an offscreen renderer
   * (`mountOffscreen`). `shift` moves the frame center off the view axis, in tangent units
   * (perspective) or world units (parallel); `background` null leaves it transparent. The grid,
   * axes and sky are not drawn. Resolves to '' without a renderer.
   */
  snapshot(width: number, height: number, camera: CameraState, opts: SnapshotOptions): string {
    return this.renderSnapshot(width, height, camera, opts, canvas => canvas.toDataURL('image/png'), '');
  }

  /**
   * `snapshot` drawn into `target` (resized to the render) instead of encoded, for pictures that
   * are painted right away, such as navigation previews. Returns false without a renderer.
   */
  snapshotInto(target: HTMLCanvasElement, width: number, height: number, camera: CameraState, opts: SnapshotOptions): boolean {
    return this.renderSnapshot(width, height, camera, opts, canvas => {
      target.width = canvas.width;
      target.height = canvas.height;
      const ctx = target.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(canvas, 0, 0);
      return true;
    }, false);
  }

  /**
   * Draw the current view as the screen shows it into a new `width × height` canvas (2D graphic export): the
   * same camera, the style's background or sky, shadows and fog, without the grid, the axes or the tools' overlay.
   * It renders with its own renderer, so anti-aliasing can be switched and the screen's drawing buffer is untouched;
   * the view is restored afterwards. `transparent` leaves the background and sky out. Null where WebGL is unavailable
   * or the picture cannot be drawn.
   */
  renderImage(width: number, height: number, opts: ImageOptions): HTMLCanvasElement | null {
    if (typeof document === 'undefined') return null;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: opts.antialias, alpha: true, preserveDrawingBuffer: true, stencil: true, canvas: document.createElement('canvas') });
    } catch {
      return null;
    }
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    const before = { width: this.width, height: this.height, grid: this.grid.visible, axes: this.axes.visible, sky: this.sky.visible, background: this.scene.background };
    try {
      renderer.setPixelRatio(1);
      renderer.localClippingEnabled = true;
      this.sunLight.configureRenderer(renderer);
      renderer.setSize(w, h, false);
      renderer.setClearColor(0xffffff, 0);
      this.width = w;
      this.height = h;
      this.camera.setSize(w, h);
      this.sceneSync.setResolution(w, h, 1);
      this.grid.visible = false;
      this.axes.visible = false;
      if (opts.transparent) { this.sky.visible = false; this.scene.background = null; }
      const cam = this.camera.three, state = this.camera.getState(), fwd = cameraForward(state);
      const wppAt = (p: Vec3): number =>
        worldPerPixelAtDepth(state, Math.max(1e-6, (p[0] - state.eye[0]) * fwd[0] + (p[1] - state.eye[1]) * fwd[1] + (p[2] - state.eye[2]) * fwd[2]), h);
      this.sceneSync.dimensions.update(cam, wppAt);
      this.sceneSync.sections.update(cam, wppAt);
      this.sceneSync.texts.update(cam, wppAt);
      this.sceneSync.updateEdgeDepth(state.eye, fwd);
      const sun = this.shadowSettings.enabled ? this.sunLight.current.sunDirection : null;
      this.sceneSync.updateFaceCamera({ eye: state.eye, forward: fwd, parallel: state.projection === 'parallel' }, sun);
      if (this.shadowSettings.enabled) this.sunLight.fit(this.sceneSync.sceneBounds());
      if (this.sky.visible) this.sky.update(cam, w / h);
      this.sceneSync.prepareFrame();
      renderer.render(this.scene, cam);
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(renderer.domElement, 0, 0);
      return out;
    } catch {
      return null;
    } finally {
      this.grid.visible = before.grid;
      this.axes.visible = before.axes;
      this.sky.visible = before.sky;
      this.scene.background = before.background;
      renderer.dispose();
      renderer.forceContextLoss();
      if (this.container && this.renderer) this.resize();
      else {
        this.width = before.width;
        this.height = before.height;
        this.camera.setSize(before.width, before.height);
        this.sceneSync.setResolution(before.width, before.height, 1);
      }
      this.requestRender();
    }
  }

  private renderSnapshot<T>(width: number, height: number, camera: CameraState, opts: SnapshotOptions, read: (canvas: HTMLCanvasElement) => T, none: T): T {
    const renderer = this.renderer;
    if (!renderer) return none;
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    const shown = this.container ? this.camera.getState() : null;
    this.width = w;
    this.height = h;
    renderer.setSize(w, h, false);
    this.camera.setSize(w, h);
    this.sceneSync.setResolution(w, h, 1);
    this.camera.setState(camera, false);
    const three = this.camera.three as unknown as { setViewOffset?: (fw: number, fh: number, x: number, y: number, vw: number, vh: number) => void; clearViewOffset?: () => void };
    const [sx, sy] = opts.shift ?? [0, 0];
    const perUnit = camera.projection === 'parallel' ? h / camera.orthoHeight : h / (2 * Math.tan((camera.fov * Math.PI) / 360));
    if (sx || sy) three.setViewOffset?.(w, h, sx * perUnit, -sy * perUnit, w, h);
    const visible = { grid: this.grid.visible, axes: this.axes.visible, sky: this.sky.visible, background: this.scene.background };
    this.grid.visible = false;
    this.axes.visible = false;
    this.sky.visible = false;
    this.scene.background = opts.background === null ? null : new Color(opts.background);
    // Hidden-line faces take the picture's background, or white paper where it has none.
    const faceBackground = this.sceneSync.backgroundColor();
    this.sceneSync.setBackgroundColor(opts.background === null ? 0xffffff : new Color(opts.background).getHex());
    renderer.setClearColor(0xffffff, 0);
    try {
      const fwd = cameraForward(camera);
      const snapshotWpp = (p: Vec3): number =>
        worldPerPixelAtDepth(camera, Math.max(1e-6, (p[0] - camera.eye[0]) * fwd[0] + (p[1] - camera.eye[1]) * fwd[1] + (p[2] - camera.eye[2]) * fwd[2]), h);
      this.sceneSync.dimensions.update(this.camera.three, snapshotWpp);
      this.sceneSync.texts.update(this.camera.three, snapshotWpp);
      this.sceneSync.sections.update(this.camera.three, snapshotWpp);
      // face-camera placements face the picture's camera; the next frame turns them back
      this.sceneSync.updateFaceCamera({ eye: camera.eye, forward: fwd, parallel: camera.projection === 'parallel' }, this.shadowSettings.enabled ? this.sunLight.current.sunDirection : null);
      this.sceneSync.prepareFrame();
      renderer.render(this.scene, this.camera.three);
      return read(renderer.domElement);
    } catch {
      return none;
    } finally {
      three.clearViewOffset?.();
      // An on-screen viewport (cloud thumbnails draw through it) goes back to its own size and camera, or picking and
      // drawing would keep the picture's size until the window next resized.
      if (shown) {
        this.camera.setState(shown, false);
        this.resize();
      }
      this.grid.visible = visible.grid;
      this.axes.visible = visible.axes;
      this.sky.visible = visible.sky;
      this.scene.background = visible.background;
      this.sceneSync.setBackgroundColor(faceBackground);
    }
  }

  /** Style background (sky/ground gradient or solid color). */
  setSky(settings: RenderBackground): void {
    this.sky.setSettings(settings);
    this.sky.visible = true;
    this.scene.background = null;
    const c = new Color(settings.color);
    this.sceneSync.setBackgroundColor(c.getHex());
    this.requestRender();
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  mount(container: HTMLElement): void {
    if (this.renderer) this.unmount();
    this.container = container;
    const renderer = new WebGLRenderer({ antialias: true, alpha: false, stencil: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // Section cuts clip per object and fill through the stencil buffer.
    renderer.localClippingEnabled = true;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.sunLight.configureRenderer(renderer);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  unmount(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.renderer) {
      this.renderer.domElement.remove();
      this.renderer.dispose();
      this.renderer = null;
    }
    this.container = null;
  }

  dispose(): void {
    this.unmount();
    this.sceneSync.dispose();
    this.overlay.dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.axes.dispose();
    this.sunLight.dispose();
  }

  resize(): void {
    if (!this.container || !this.renderer) return;
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.setSize(width, height);
    this.sceneSync.setResolution(width, height, this.renderer.getPixelRatio());
    this.overlay.setSize(width, height, this.renderer.getPixelRatio());
    this.events.emit('resize', { width, height });
    this.requestRender();
  }

  /** Replace the drawable bodies (every instance flattened; diffed by render key/version). */
  setBodies(bodies: readonly RenderBody[]): void {
    if (this.sceneSync.sync(bodies)) this.afterGeometryChange();
  }

  /** Replace the sketches, one per container (diffed by id and `version` identity). */
  setSketches(sketches: readonly RenderSketch[]): void {
    if (this.sceneSync.syncSketches(sketches)) this.afterGeometryChange();
  }

  /** Single root sketch convenience: `setSketches(sketch ? [sketch] : [])`. */
  setSketch(sketch: RenderSketch | null): void {
    this.setSketches(sketch ? [sketch] : []);
  }

  /**
   * Component edit display: fade or hide everything outside `ctx.path` and draw the context
   * instance's dashed bounding box. Hidden entities drop out of picking.
   */
  setEditContext(ctx: RenderEditContext): void {
    if (this.sceneSync.setEditContext(ctx)) this.afterGeometryChange();
  }

  get editContext(): RenderEditContext {
    return this.sceneSync.editContext;
  }

  /** Hover + selection highlights (face overlays, thick edges, body/instance tint, vertex squares). */
  setHighlight(state: HighlightState): void {
    this.sceneSync.setHighlight(state);
    this.requestRender();
  }

  /** Tint bodies by render key or by the path key of an instance containing them (see `SceneSync.setSelectedKeys`). */
  setSelectedKeys(keys: ReadonlySet<string>): void {
    this.sceneSync.setSelectedKeys(keys);
    this.requestRender();
  }

  /** Translucent preview bodies (Push/Pull real preview); null or [] clears. */
  setPreview(meshes: readonly MeshData[] | null, transform?: Mat4): void {
    if (this.sceneSync.setPreview(meshes, transform)) this.requestRender();
  }

  /** Hidden-geometry display mode: soft/hidden edges dashed, hidden faces drawn. */
  get showHiddenGeometry(): boolean {
    return this.sceneSync.showHiddenGeometry;
  }
  setShowHiddenGeometry(on: boolean): void {
    if (this.sceneSync.setShowHiddenGeometry(on)) this.requestRender();
  }

  /** Edge widths: normal px, profiles on/off, profile px (defaults 1 / on / 2). */
  setEdgeStyle(style: EdgeStyle): void {
    this.sceneSync.setEdgeStyle(style);
    this.requestRender();
  }

  /** Construction guides of the edit context (diffed by object identity); null clears. */
  /** Texts of the model. */
  setTexts(texts: RenderTexts | null): void {
    if (!this.sceneSync.setTexts(texts)) return;
    if (this.renderer) void this.sceneSync.texts.prepare();
    this.requestRender();
  }

  setDimensions(dimensions: RenderDimensions | null): void {
    if (this.sceneSync.setDimensions(dimensions)) this.requestRender();
  }

  /** Section planes and active cuts, diffed by object identity; null clears. */
  setSections(sections: RenderSections | null): void {
    if (this.sceneSync.setSections(sections)) this.requestRender();
  }

  /** Placed pictures. */
  setImages(images: readonly RenderImage[]): void {
    if (this.sceneSync.setImages(images)) this.requestRender();
  }

  setGuides(guides: RenderGuides | null): void {
    if (this.sceneSync.setGuides(guides)) this.requestRender();
  }

  /** Move/rotate the drawing axes gizmo and the ground grid to the given axes. */
  setAxes(axes: RenderAxes): void {
    this.axes.setAxes(axes);
    this.grid.setAxes(axes);
    this.requestRender();
  }

  /** Current display settings (defaults = the shaded look with profiles, guides and axes on). */
  get display(): RenderDisplay {
    return this.sceneSync.display;
  }

  /**
   * Apply display settings (partial): hidden geometry, edges/profiles/back edges, guides and
   * axes visibility, X-ray and the face style (shaded, wireframe, hidden line, monochrome).
   */
  setDisplay(display: Partial<RenderDisplay>): void {
    const changed = this.sceneSync.setDisplay(display);
    const axesVisible = this.sceneSync.display.axes;
    if (this.axes.visible !== axesVisible) this.axes.visible = axesVisible;
    if (changed) this.requestRender();
  }

  /** Viewport background color (also used for hidden-line faces). */
  /** Solid background color (hides the sky/ground gradient). */
  setBackground(hex: number): void {
    this.sky.visible = false;
    this.scene.background = new Color(hex);
    this.sceneSync.setBackgroundColor(hex);
    this.requestRender();
  }

  private afterGeometryChange(): void {
    this.ensureBoundsTrees();
    this.requestRender();
  }

  /** Picking acceleration for every pickable mesh that lacks it (rebuilt batches included). */
  private ensureBoundsTrees(): void {
    for (const m of this.sceneSync.pickables()) {
      const geom = (m as Mesh).geometry as BufferGeometry & { computeBoundsTree?: () => void; boundsTree?: unknown };
      if (geom.computeBoundsTree && !geom.boundsTree) geom.computeBoundsTree();
    }
  }

  setOverlay(prims: readonly OverlayPrimitive[]): void {
    this.overlayPrims = prims;
    const hint = prims.find((p): p is Extract<OverlayPrimitive, { kind: 'cursorHint' }> => p.kind === 'cursorHint');
    const text = hint?.text ?? null;
    if (text !== this.lastCursorHint) {
      this.lastCursorHint = text;
      this.events.emit('cursorHint', hint ? { text: hint.text, screen: hint.screen ?? null } : null);
    }
    this.requestRender();
  }

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
    this.requestRender();
  }

  /** Floating origin for render precision; geometry is rebuilt relative to it. */
  setOrigin(origin: Vec3): void {
    this.sceneSync.setOrigin(origin);
    this.camera.setOrigin(origin);
    this.overlay.setOrigin(origin);
    this.grid.setOrigin(origin[0], origin[1], origin[2]);
    this.axes.setOrigin(origin[0], origin[1], origin[2]);
    this.sunLight.setOrigin(origin);
    this.requestRender();
  }

  /** World point → viewport CSS px (may lie outside the viewport; points behind the eye are unreliable). */
  project(p: Vec3): Vec2 {
    const v = new Vector3(p[0], p[1], p[2]).project(this.camera.three);
    const { width, height } = this.size;
    return [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height];
  }

  /** World size of one CSS pixel at parameter t along `ray` (for pick tolerances). */
  pixelSizeAlong(ray: Ray): (t: number) => number {
    const state = this.camera.getState();
    const fwd = cameraForward(state);
    const h = this.height;
    const d0 = (ray.origin[0] - state.eye[0]) * fwd[0] + (ray.origin[1] - state.eye[1]) * fwd[1] + (ray.origin[2] - state.eye[2]) * fwd[2];
    const dd = ray.dir[0] * fwd[0] + ray.dir[1] * fwd[1] + ray.dir[2] * fwd[2];
    return (t) => worldPerPixelAtDepth(state, Math.max(1e-6, d0 + dd * t), h);
  }

  screenToRay(x: number, y: number): Ray {
    return this.camera.screenToRay(x, y);
  }

  /** CPU pick against body faces; returns the world point or null. */
  pick(screen: Vec2): Vec3 | null {
    const pickables = this.sceneSync.pickables();
    if (!pickables.length) return null;
    const ndc = new Vector2((screen[0] / this.width) * 2 - 1, 1 - (screen[1] / this.height) * 2);
    this.raycaster.setFromCamera(ndc, this.camera.three);
    const hits = this.raycaster.intersectObjects(pickables, false);
    const hit = hits[0];
    if (!hit) return null;
    const o = this.camera.getOrigin();
    return [hit.point.x + o[0], hit.point.y + o[1], hit.point.z + o[2]];
  }

  sceneBounds(): Box3 | null {
    return this.sceneSync.sceneBounds();
  }

  requestRender(): void {
    if (!this.renderer || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  render(): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const cam = this.camera.three;
    const state = this.camera.getState();
    const fwd = cameraForward(state);
    const wppAt = (p: Vec3) => {
      const depth = (p[0] - state.eye[0]) * fwd[0] + (p[1] - state.eye[1]) * fwd[1] + (p[2] - state.eye[2]) * fwd[2];
      return worldPerPixelAtDepth(state, depth, this.height);
    };
    this.overlay.set(this.overlayPrims, cam, wppAt);
    this.sceneSync.dimensions.update(cam, wppAt);
    this.sceneSync.texts.update(cam, wppAt);
    this.sceneSync.sections.update(cam, wppAt);
    this.sceneSync.updateEdgeDepth(state.eye, fwd);
    const sun = this.shadowSettings.enabled ? this.sunLight.current.sunDirection : null;
    this.sceneSync.updateFaceCamera({ eye: state.eye, forward: fwd, parallel: state.projection === 'parallel' }, sun);
    if (this.shadowSettings.enabled) this.sunLight.fit(this.sceneSync.sceneBounds());
    if (this.sky.visible) this.sky.update(cam, this.width / Math.max(1, this.height));
    renderer.autoClear = true;
    if (this.sceneSync.prepareFrame()) this.ensureBoundsTrees();
    renderer.render(this.scene, cam);
    this.overlay.render(renderer, cam);
    this.events.emit('render', undefined);
  }
}
