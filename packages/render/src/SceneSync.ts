// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { box3Empty, box3Expand, box3IsEmpty, m4transformPoint, meshBounds } from '@pushform/core';
import type { Box3, MeshData, Vec3, Mat4 } from '@pushform/core';
import { Color, Group, SRGBColorSpace } from 'three';
import type { BufferAttribute, Mesh, MeshLambertMaterial, Object3D } from 'three';
import { BodyRenderable, FADE_OPACITY, createBodyMaterials, hiddenLineShade } from './renderables/BodyRenderable';
import { SceneBatches } from './renderables/SceneBatches';
import type { BodyMaterials } from './renderables/BodyRenderable';
import { EdgeBatch } from './renderables/EdgeBatch';
import { createEdgeMaterial, DEFAULT_EDGE_WIDTH } from './renderables/EdgeMaterial';
import type { EdgeMaterial } from './renderables/EdgeMaterial';
import { GuideLayer } from './renderables/GuideLayer';
import { applyFaceCamera, type FaceCameraView } from './renderables/faceCamera';
import { HighlightLayer, box3Segments } from './renderables/HighlightLayer';
import { ImageLayer, imageCorners } from './renderables/ImageLayer';
import { PreviewLayer } from './renderables/PreviewLayer';
import { ImportPreviewLayer } from './renderables/ImportPreviewLayer';
import { SketchRenderable, createSketchMaterials } from './renderables/SketchRenderable';
import { TextureCache, TexturedMaterialCache } from './materials/TextureCache';
import type { SketchMaterials } from './renderables/SketchRenderable';
import { DEFAULT_DISPLAY, EMPTY_HIGHLIGHT, EMPTY_SECTIONS, ROOT_EDIT_CONTEXT, renderKeyWithinInstance, renderPathKey, renderPathWithin } from './types';
import type { HighlightState, RenderBody, RenderDimensions, RenderDisplay, RenderEditContext, RenderGuides, RenderImage, RenderSections, RenderSketch, RenderTexts } from './types';
import { DimensionLayer } from './renderables/DimensionLayer';
import { TextLayer } from './renderables/TextLayer';
import { SectionLayer } from './renderables/SectionLayer';
import { setObjectClipping } from './renderables/sectionGeometry';
import { BACK_COLOR as DEFAULT_BACK_COLOR, FRONT_COLOR as DEFAULT_FRONT_COLOR, SELECT_COLOR, palette } from './renderables/palette';
import { EDGE_COLOR } from './renderables/EdgeMaterial';
import { GUIDE_COLOR } from './renderables/GuideLayer';

/** Face opacity in X-ray mode. */
export const XRAY_OPACITY = 0.35;
/** Dashed grey of the open context's bounding box (the component edit box). */
export const CONTEXT_BOX_COLOR = 0x7b8794;

export interface EdgeStyle {
  /** Normal edge width in CSS px (default 1). */
  readonly width?: number | undefined;
  /** Draw profiles/silhouettes thicker (default true). */
  readonly profiles?: boolean | undefined;
  /** Profile width in CSS px (default 2). */
  readonly profileWidth?: number | undefined;
}

export interface ResolvedEdgeStyle {
  readonly width: number;
  readonly profiles: boolean;
  readonly profileWidth: number;
}

/** Something with a container path that can be faded/hidden by the edit context. */
interface ContextAware extends Object3D {
  readonly path: readonly number[];
  readonly isFaded: boolean;
}

/**
 * Keeps three.js renderables in sync with a list of `RenderBody` (every instance flattened with
 * its world transform), one sketch per container, the highlight state, the edit context and the
 * preview meshes. Bodies and sketches are diffed by their string render key (`path/id`, resp.
 * the path key) and version (or object identity). The floating origin is applied when geometry
 * is (re)built. Bodies and sketches draw through `SceneBatches` (merged per material) unless they turn to face the
 * camera, are hidden by the edit context, or section cuts are active; then they draw themselves (PF-191).
 */
export class SceneSync {
  readonly root = new Group();
  readonly materials: BodyMaterials = createBodyMaterials();
  /** Materials of entities outside the open edit context (translucent faces, grey edges). */
  readonly fadedMaterials: BodyMaterials = createBodyMaterials({ faded: true });
  readonly sketchMaterials: SketchMaterials = createSketchMaterials();
  readonly fadedSketchMaterials: SketchMaterials = createSketchMaterials({ faded: true });
  readonly highlight = new HighlightLayer();
  /** Texture images and the per-material Lambert materials of textured / translucent faces. */
  readonly textures = new TextureCache();
  readonly texturedMaterials = new TexturedMaterialCache(this.textures);
  /** Placed pictures. */
  readonly images = new ImageLayer(this.textures);
  readonly preview: PreviewLayer;
  /** Parts of a model still being imported, outside the document. */
  readonly importPreview = new ImportPreviewLayer();
  readonly guides = new GuideLayer();
  readonly dimensions = new DimensionLayer();
  readonly texts = new TextLayer();
  /** Section planes, their cut fill and section lines. */
  readonly sections = new SectionLayer();
  /** Dashed bounding box of the open context instance. */
  readonly contextBox: EdgeBatch;
  /** Merged face meshes and edge batches of the bodies and sketches drawn together (PF-191). */
  readonly batches = new SceneBatches();
  readonly contextBoxMaterial: EdgeMaterial;
  private bodies = new Map<string, BodyRenderable>();
  private sketches = new Map<string, SketchRenderable>();
  private origin: Vec3 = [0, 0, 0];
  private bounds: Box3 | null = null;
  private boundsDirty = true;
  private lastBodies: readonly RenderBody[] = [];
  private lastSketches: readonly RenderSketch[] = [];
  private highlightState: HighlightState = EMPTY_HIGHLIGHT;
  private selectedKeys = new Set<string>();
  private selectedInstanceKeys: string[] = [];
  private selectedSketchFaces = new Set<number>();
  private _editContext: RenderEditContext = ROOT_EDIT_CONTEXT;
  private _showHiddenGeometry = false;
  private edgeStyle: ResolvedEdgeStyle = { width: 1, profiles: true, profileWidth: 2 };
  private _display: RenderDisplay = DEFAULT_DISPLAY;
  private background = new Color(0xe9eef4);
  /** With shadows on faces, the shade (sRGB factor) of hidden-line faces the sun does not reach; null when off. */
  private sunShade: number | null = null;
  private sectionsData: RenderSections = EMPTY_SECTIONS;
  /** Whether any renderable may carry clipping hooks from an earlier cut. */
  private clipped = false;
  /** Whether bodies and sketches were batched when sections were last applied. */
  private batchedLast = true;

  constructor() {
    this.root.name = 'Model';
    this.preview = new PreviewLayer(this.materials.edge);
    this.contextBoxMaterial = createEdgeMaterial({ width: DEFAULT_EDGE_WIDTH, profileWidth: DEFAULT_EDGE_WIDTH, dashed: true, color: CONTEXT_BOX_COLOR });
    this.contextBoxMaterial.dashSize = 6;
    this.contextBoxMaterial.gapSize = 4;
    this.contextBox = new EdgeBatch(this.contextBoxMaterial);
    this.contextBox.name = 'ContextBox';
    this.contextBox.visible = false;
    this.root.add(this.batches.group, this.images.group, this.highlight.group, this.preview.group, this.importPreview.group, this.guides.group, this.dimensions.group, this.texts.group, this.sections.group, this.contextBox);
  }

  /** Face meshes for picking (visible bodies and sketch faces, merged where they are batched). */
  pickables(): Object3D[] {
    this.prepareFrame();
    const out: Object3D[] = [...this.batches.faceMeshes()];
    for (const b of this.bodies.values()) if (b.visible && !this.batches.has(b)) out.push(b.front);
    for (const s of this.sketches.values()) if (s.visible && s.front.visible && !this.batches.has(s)) out.push(s.front);
    for (const r of this.images.renderables) if (r.visible) out.push(r);
    return out;
  }

  /** The body and sketch renderables, batched or drawing themselves. */
  renderables(): (BodyRenderable | SketchRenderable)[] {
    return [...this.bodies.values(), ...this.sketches.values()];
  }

  /** Every solid and sheet face mesh, drawn or batched, and the batches' merged ones (switching On Faces shadows). */
  faceMeshes(): Mesh[] {
    return [...this.renderables().flatMap((r) => [r.front, r.back]), ...this.batches.allFaceMeshes().filter((m) => m.userData['receiveShadows'] !== undefined)];
  }

  /** Rebuild the batches whose members changed; call before drawing. Returns true when any geometry changed. */
  prepareFrame(): boolean {
    return this.batches.flush();
  }

  /** Bodies and sketches draw batched unless section cuts clip them per path. */
  private get batching(): boolean {
    return this.sectionsData.cuts.length === 0 && !this.clipped;
  }

  /**
   * Put a body or sketch in the batches, or back in the scene to draw itself: those turning to face the camera, those
   * the edit context hides, and all of them while section cuts are active (PF-191). Call after anything it draws changed.
   */
  private stage(r: BodyRenderable | SketchRenderable): void {
    if (this.batching && r.visible && !r.faceCamera) {
      if (r.parent === this.root) this.root.remove(r);
      this.batches.update(r);
    } else {
      this.batches.remove(r);
      if (r.parent !== this.root) this.root.add(r);
    }
  }

  /** Copy a batched source's selection tint into its batches when it changed. */
  private stageFlags(r: BodyRenderable | SketchRenderable, before: number | undefined): void {
    if (this.batches.has(r) && flagsVersion(r) !== before) this.batches.syncFlags(r);
  }

  private get faceMaterialSets(): readonly [BodyMaterials | SketchMaterials, boolean][] {
    return [
      [this.materials, false],
      [this.sketchMaterials, false],
      [this.fadedMaterials, true],
      [this.fadedSketchMaterials, true],
    ];
  }

  private get edgeMaterialSets(): readonly BodyMaterials[] {
    return [this.materials, this.fadedMaterials];
  }

  sync(bodies: readonly RenderBody[]): boolean {
    let changed = false;
    const seen = new Set<string>();
    for (const body of bodies) {
      seen.add(body.id);
      let r = this.bodies.get(body.id);
      let staged = false;
      if (!r) {
        r = new BodyRenderable(body.id, this.materials, this.texturedMaterials);
        r.setShowHidden(this._showHiddenGeometry);
        r.setTextured(this._display.faceStyle === 'shadedTextured');
        this.bodies.set(body.id, r);
        r.update(body, this.origin);
        r.setSelected(this.isKeySelected(body.id));
        this.applyContextTo(r, (faded) => r!.setMaterials(faded ? this.fadedMaterials : this.materials, faded));
        changed = staged = true;
      } else if (r.needsUpdate(body)) {
        r.update(body, this.origin);
        changed = staged = true;
      }
      if (!!r.faceCamera !== !!body.faceCamera) staged = true;
      r.faceCamera = body.faceCamera;
      if (staged) this.stage(r);
    }
    for (const [id, r] of this.bodies) {
      if (seen.has(id)) continue;
      this.batches.remove(r);
      this.root.remove(r);
      r.dispose();
      this.bodies.delete(id);
      changed = true;
    }
    this.lastBodies = bodies;
    if (changed) {
      this.boundsDirty = true;
      this.refreshSections();
    }
    return changed;
  }

  /**
   * Turn the bodies and sketches of placements that Always Face Camera toward the camera, and their shadows toward
   * the sun when they Shadow Face Sun. Called before every frame.
   */
  updateFaceCamera(view: FaceCameraView, sunDirection: Vec3 | null): void {
    for (const r of this.bodies.values()) applyFaceCamera(r, [r.front, r.back], r.faceCamera, view, sunDirection, this.origin);
    for (const r of this.sketches.values()) applyFaceCamera(r, [r.front, r.back], r.faceCamera, view, sunDirection, this.origin);
  }

  /** Replace the sketches (one per container, diffed by id and `version` identity). */
  syncSketches(sketches: readonly RenderSketch[]): boolean {
    let changed = false;
    const seen = new Set<string>();
    for (const sketch of sketches) {
      seen.add(sketch.id);
      let r = this.sketches.get(sketch.id);
      let staged = false;
      if (!r) {
        r = new SketchRenderable(sketch.id, this.sketchMaterials, this.materials, this.texturedMaterials);
        r.setShowHidden(this._showHiddenGeometry);
        r.setTextured(this._display.faceStyle === 'shadedTextured');
        this.sketches.set(sketch.id, r);
        r.update(sketch, this.origin);
        r.setSelectedFaces(this.selectedSketchFaces);
        this.applyContextTo(r, (faded) =>
          r!.setMaterials(faded ? this.fadedSketchMaterials : this.sketchMaterials, faded ? this.fadedMaterials : this.materials, faded),
        );
        changed = staged = true;
      } else if (r.needsUpdate(sketch)) {
        r.update(sketch, this.origin);
        r.setSelectedFaces(this.selectedSketchFaces);
        changed = staged = true;
      }
      if (!!r.faceCamera !== !!sketch.faceCamera) staged = true;
      r.faceCamera = sketch.faceCamera;
      // A placement's Cast/Receive Shadows can change without its definition's sketch changing.
      if (r.setShadows(sketch.castShadows !== false, sketch.receiveShadows !== false)) changed = staged = true;
      if (staged) this.stage(r);
    }
    for (const [id, r] of this.sketches) {
      if (seen.has(id)) continue;
      this.batches.remove(r);
      this.root.remove(r);
      r.dispose();
      this.sketches.delete(id);
      changed = true;
    }
    this.lastSketches = sketches;
    if (changed) {
      this.boundsDirty = true;
      this.refreshSections();
    }
    return changed;
  }

  /** Single-sketch convenience (root context only): `syncSketches(sketch ? [sketch] : [])`. */
  syncSketch(sketch: RenderSketch | null): boolean {
    return this.syncSketches(sketch ? [sketch] : []);
  }

  setHighlight(state: HighlightState): void {
    this.highlightState = state;
    const { bodyKeys, instanceKeys, sketchFaceIds } = this.highlight.set(state, this.origin);
    this.setSelectedKeys(new Set([...bodyKeys, ...instanceKeys]));
    this.selectedSketchFaces = sketchFaceIds;
    this.applySketchSelection();
  }

  /**
   * Tint bodies through their `flags` attribute: a body is tinted when its render key is in `keys`
   * or when `keys` holds the path key of an instance it lives in (any depth).
   */
  setSelectedKeys(keys: ReadonlySet<string>): void {
    this.selectedKeys = new Set(keys);
    this.selectedInstanceKeys = [...keys].filter((k) => !k.includes('/'));
    for (const [key, r] of this.bodies) {
      const before = flagsVersion(r);
      r.setSelected(this.isKeySelected(key));
      this.stageFlags(r, before);
    }
  }

  private isKeySelected(key: string): boolean {
    if (this.selectedKeys.has(key)) return true;
    for (const ik of this.selectedInstanceKeys) if (renderKeyWithinInstance(key, ik)) return true;
    return false;
  }

  private applySketchSelection(): void {
    for (const s of this.sketches.values()) {
      const before = flagsVersion(s);
      s.setSelectedFaces(this.selectedSketchFaces);
      this.stageFlags(s, before);
    }
  }

  // --- edit context ---------------------------------------------------------------------------

  get editContext(): RenderEditContext {
    return this._editContext;
  }

  /**
   * Open edit context: entities whose path is not within it are faded (translucent faces that
   * still write depth, grey edges) or hidden; the context instance's bounds are drawn as a dashed
   * box when the path is non-empty. Returns true when anything changed.
   */
  setEditContext(ctx: RenderEditContext): boolean {
    const prev = this._editContext;
    const sameBounds =
      prev.bounds === ctx.bounds ||
      (!!prev.bounds && !!ctx.bounds && prev.bounds.min.every((v, i) => v === ctx.bounds!.min[i]) && prev.bounds.max.every((v, i) => v === ctx.bounds!.max[i]));
    if (
      renderPathKey(prev.path) === renderPathKey(ctx.path) &&
      prev.fadeOthers === ctx.fadeOthers &&
      prev.hideOthers === ctx.hideOthers &&
      sameBounds
    ) {
      return false;
    }
    this._editContext = ctx;
    for (const r of this.bodies.values()) {
      if (this.applyContextTo(r, (faded) => r.setMaterials(faded ? this.fadedMaterials : this.materials, faded))) this.stage(r);
    }
    for (const r of this.sketches.values()) {
      const moved = this.applyContextTo(r, (faded) =>
        r.setMaterials(faded ? this.fadedSketchMaterials : this.sketchMaterials, faded ? this.fadedMaterials : this.materials, faded),
      );
      if (moved) this.stage(r);
    }
    this.applyImageDisplay();
    this.updateContextBox();
    this.refreshSections();
    return true;
  }

  /** Placed pictures; returns true when anything changed. */
  setImages(images: readonly RenderImage[]): boolean {
    if (!this.images.set(images, this.origin)) return false;
    this.applyImageDisplay();
    this.boundsDirty = true;
    this.refreshSections();
    return true;
  }

  /** Pictures follow the edit context (faded or hidden outside it), X-ray, and wireframe (no faces). */
  private applyImageDisplay(): void {
    const d = this._display;
    this.images.group.visible = d.faceStyle !== 'wireframe';
    const xray = d.xray ? d.xrayOpacity ?? XRAY_OPACITY : null;
    const ctx = this._editContext;
    for (const r of this.images.renderables) {
      const inside = ctx.path.length === 0 || renderPathWithin(r.path, ctx.path);
      r.visible = inside || !ctx.hideOthers;
      r.setOpacity(!inside && ctx.fadeOthers && !ctx.hideOthers, xray);
    }
  }

  /** Visibility and material set of one renderable under the current edit context; true when either changed. */
  private applyContextTo(r: ContextAware, swap: (faded: boolean) => void): boolean {
    const ctx = this._editContext;
    const inside = ctx.path.length === 0 || renderPathWithin(r.path, ctx.path);
    const visible = inside || !ctx.hideOthers;
    const faded = !inside && ctx.fadeOthers && !ctx.hideOthers;
    const changed = r.visible !== visible || r.isFaded !== faded;
    r.visible = visible;
    if (r.isFaded !== faded) swap(faded);
    return changed;
  }

  private updateContextBox(): void {
    const ctx = this._editContext;
    if (ctx.path.length === 0 || !ctx.bounds) {
      this.contextBox.setSegments(new Float32Array(0));
      return;
    }
    const o = this.origin;
    const pos: number[] = [];
    for (const [a, b] of box3Segments(ctx.bounds.min, ctx.bounds.max)) {
      pos.push(a[0] - o[0], a[1] - o[1], a[2] - o[2], b[0] - o[0], b[1] - o[1], b[2] - o[2]);
    }
    this.contextBox.setSegments(new Float32Array(pos));
  }

  // --- previews / modes -----------------------------------------------------------------------

  setPreview(meshes: readonly MeshData[] | null, transform?: Mat4): boolean {
    return this.preview.set(meshes, this.origin, transform);
  }

  get showHiddenGeometry(): boolean {
    return this._showHiddenGeometry;
  }

  setShowHiddenGeometry(on: boolean): boolean {
    if (this._showHiddenGeometry === on) return false;
    this._showHiddenGeometry = on;
    if (this._display.hiddenGeometry !== on) this._display = { ...this._display, hiddenGeometry: on };
    for (const sketch of this.lastSketches) {
      const r = this.sketches.get(sketch.id);
      if (r && r.setShowHidden(on)) {
        r.update(sketch, this.origin);
        r.setSelectedFaces(this.selectedSketchFaces);
        this.stage(r);
      }
    }
    for (const body of this.lastBodies) {
      const r = this.bodies.get(body.id);
      if (r && r.setShowHidden(on)) {
        r.update(body, this.origin);
        this.stage(r);
      }
    }
    this.refreshSections();
    return true;
  }

  setEdgeStyle(style: EdgeStyle): void {
    this.edgeStyle = {
      width: style.width ?? this.edgeStyle.width,
      profiles: style.profiles ?? this.edgeStyle.profiles,
      profileWidth: style.profileWidth ?? this.edgeStyle.profileWidth,
    };
    if (this._display.profiles !== this.edgeStyle.profiles) this._display = { ...this._display, profiles: this.edgeStyle.profiles };
    const { width, profiles, profileWidth } = this.edgeStyle;
    for (const m of this.edgeMaterialSets) {
      m.edge.linewidth = width;
      m.edge.profileWidth = profiles ? profileWidth : width;
      m.hiddenEdge.linewidth = width;
      m.hiddenEdge.profileWidth = width;
      m.backEdge.linewidth = width;
      m.backEdge.profileWidth = width;
    }
  }

  // --- display settings ---------------------------------------------------------------------

  get display(): RenderDisplay {
    return this._display;
  }

  /** Background color used by the hidden-line face style. */
  backgroundColor(): number {
    return this.background.getHex();
  }

  /** Background color used by the hidden-line face style. */
  setBackgroundColor(hex: number): void {
    this.background.set(hex);
    if (this._display.faceStyle === 'hiddenLine') this.applyFaceStyle();
  }

  /**
   * With shadows on faces, hidden-line faces the sun does not reach (in shadow or turned away) draw in the
   * background color times `shade`, an sRGB factor; null draws them flat (set by `Viewport.setShadows`).
   */
  setSunShade(shade: number | null): void {
    if (this.sunShade === shade) return;
    this.sunShade = shade;
    if (this._display.faceStyle === 'hiddenLine') this.applyFaceStyle();
  }

  /**
   * Apply a (partial) display update. Hidden geometry rebuilds the sketch/body edge batches; the
   * rest flips material flags only. Returns true when anything changed.
   */
  setDisplay(partial: Partial<RenderDisplay>): boolean {
    const prev = this._display;
    const next: RenderDisplay = { ...prev };
    let changed = false;
    for (const k of Object.keys(partial) as (keyof RenderDisplay)[]) {
      const v = partial[k];
      if (v === undefined || v === prev[k]) continue;
      (next as Record<keyof RenderDisplay, unknown>)[k] = v;
      changed = true;
    }
    if (!changed) return false;
    this._display = next;
    if (next.hiddenGeometry !== this._showHiddenGeometry) this.setShowHiddenGeometry(next.hiddenGeometry);
    if (next.profiles !== this.edgeStyle.profiles) this.setEdgeStyle({ profiles: next.profiles });
    if (next.profileWidth !== undefined && next.profileWidth !== this.edgeStyle.profileWidth) this.setEdgeStyle({ profileWidth: next.profileWidth });
    this.applyStyleColors(prev);
    this.applyFaceStyle();
    return true;
  }

  /**
   * The style's colors: edge color and modes, the default face colors (baked into vertex colors, so
   * bodies and sketches rebuild when they change), and the selection and guide colors.
   */
  private applyStyleColors(prev: RenderDisplay): void {
    const d = this._display;
    this.materials.edge.color.set(d.edgeColor ?? EDGE_COLOR);
    for (const set of this.edgeMaterialSets) {
      for (const m of [set.edge, set.hiddenEdge, set.backEdge]) {
        m.axisColors = d.edgeAxisColors ?? false;
        m.depthCue = d.depthCue ?? 0;
        m.extension = d.edgeExtension ?? 0;
      }
    }
    const select = d.selectedColor ?? SELECT_COLOR;
    if (palette.select.getHex() !== select) {
      palette.select.set(select);
      this.highlight.setColor(select);
    }
    this.guides.setColor(d.guideColor ?? GUIDE_COLOR);
    const front = d.faceFrontColor ?? DEFAULT_FRONT_COLOR, back = d.faceBackColor ?? DEFAULT_BACK_COLOR;
    const facesChanged = palette.front.getHex() !== front || palette.back.getHex() !== back;
    if (!facesChanged && (prev.faceFrontColor ?? DEFAULT_FRONT_COLOR) === front && (prev.faceBackColor ?? DEFAULT_BACK_COLOR) === back) return;
    palette.front.set(front);
    palette.back.set(back);
    for (const body of this.lastBodies) {
      const r = this.bodies.get(body.id);
      if (!r) continue;
      r.update(body, this.origin);
      this.stage(r);
    }
    for (const sketch of this.lastSketches) {
      const r = this.sketches.get(sketch.id);
      if (!r) continue;
      r.update(sketch, this.origin);
      r.setSelectedFaces(this.selectedSketchFaces);
      this.stage(r);
    }
  }

  /**
   * Depth cue thins edges from the nearest geometry to the farthest: update that range for the camera at `eye`
   * looking along `forward` (world coordinates), each frame while depth cue is on.
   */
  updateEdgeDepth(eye: Vec3, forward: Vec3): void {
    if (!this._display.depthCue) return;
    const b = this.sceneBounds();
    if (!b) return;
    let near = Infinity, far = -Infinity;
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
      const depth = (x - eye[0]) * forward[0] + (y - eye[1]) * forward[1] + (z - eye[2]) * forward[2];
      near = Math.min(near, depth); far = Math.max(far, depth);
    }
    near = Math.max(0, near);
    for (const set of this.edgeMaterialSets) for (const m of [set.edge, set.hiddenEdge, set.backEdge]) m.setDepthRange(near, Math.max(far, near + 1e-6));
  }

  /** Push the current display settings into the shared materials (normal and faded sets). */
  private applyFaceStyle(): void {
    const d = this._display;
    const faces = d.faceStyle !== 'wireframe';
    const xray = d.xray;
    // Colors: hidden line paints faces flat in the background color (emissive, no diffuse), or with
    // shadows on faces darkens that color where the sun does not reach (`hiddenLineShade`);
    // monochrome uses the style's front/back colors and ignores materials; shaded modes multiply a white
    // material by the per-vertex colors (body default color / sketch face colors).
    const hiddenLine = d.faceStyle === 'hiddenLine';
    const shade = hiddenLine ? this.sunShade : null;
    const flat = hiddenLine && shade === null;
    hiddenLineShade.value.set(shade === null ? 0 : 1, shade === null ? 1 : new Color().setRGB(shade, 0, 0, SRGBColorSpace).r);
    const mono = d.faceStyle === 'monochrome';
    const vertexColors = !hiddenLine && !mono;
    const setColors = (m: MeshLambertMaterial, color: number) => {
      m.color.set(flat ? 0x000000 : hiddenLine ? this.background.getHex() : vertexColors ? 0xffffff : color);
      m.emissive.set(flat ? this.background : 0x000000);
      if (m.vertexColors !== vertexColors) {
        m.vertexColors = vertexColors;
        m.needsUpdate = true;
      }
    };
    for (const [set, faded] of this.faceMaterialSets) {
      for (const m of [set.front, set.back]) {
        m.visible = faces;
        m.transparent = xray || faded;
        m.opacity = xray ? d.xrayOpacity ?? XRAY_OPACITY : faded ? FADE_OPACITY : 1;
        m.depthWrite = !xray;
      }
      setColors(set.front, palette.front.getHex());
      setColors(set.back, palette.back.getHex());
    }
    // Edges: visibility, X-ray draws them on top (depth test off); back edges are exclusive with X-ray.
    for (const { edge, hiddenEdge, backEdge } of this.edgeMaterialSets) {
      edge.visible = d.edges;
      hiddenEdge.visible = d.edges;
      for (const m of [edge, hiddenEdge]) m.depthTest = !xray;
      backEdge.visible = d.edges && d.backEdges && !xray;
    }
    this.guides.group.visible = d.guides;
    // Textured / translucent face groups: maps only in the textured face style; X-ray and
    // wireframe apply to them like to the shared materials.
    const textured = d.faceStyle === 'shadedTextured';
    this.texturedMaterials.setDisplay({ xray, xrayOpacity: d.xrayOpacity ?? XRAY_OPACITY, faces });
    for (const r of [...this.bodies.values(), ...this.sketches.values()]) {
      if (r.isTextured === textured) continue;
      r.setTextured(textured);
      this.stage(r);
    }
    this.applyImageDisplay();
  }

  setTexts(texts: RenderTexts | null): boolean {
    return this.texts.set(texts, this.origin);
  }

  setDimensions(dimensions: RenderDimensions | null): boolean {
    return this.dimensions.set(dimensions, this.origin);
  }

  /** Section planes and active cuts; returns true when anything changed (compared by identity). */
  setSections(sections: RenderSections | null): boolean {
    const next = sections ?? EMPTY_SECTIONS;
    if (next === this.sectionsData) return false;
    this.sectionsData = next;
    this.refreshSections();
    return true;
  }

  /** Rebuild the section layer and the clipping of every body and sketch after a change to either. */
  private refreshSections(): void {
    const s = this.sectionsData;
    if (!this.clipped && s.cuts.length === 0 && s.planes.length === 0 && this.sections.isEmpty) return;
    const bodies = this.lastBodies.flatMap((body) => {
      const r = this.bodies.get(body.id);
      return r ? [{ body, geometry: r.front.geometry, visible: r.visible }] : [];
    });
    this.sections.set(s, bodies, this.origin, this.sceneBounds());
    for (const r of this.bodies.values()) setObjectClipping(r, this.sections.clipPlanesFor(r.path, this.origin));
    for (const r of this.sketches.values()) setObjectClipping(r, this.sections.clipPlanesFor(r.path, this.origin));
    for (const r of this.images.renderables) setObjectClipping(r, this.sections.clipPlanesFor(r.path, this.origin));
    this.clipped = s.cuts.length > 0;
    // Cuts clip per path, so bodies and sketches draw themselves while any is active.
    if (this.batching !== this.batchedLast) {
      this.batchedLast = this.batching;
      for (const r of this.renderables()) this.stage(r);
    }
  }

  setGuides(guides: RenderGuides | null): boolean {
    return this.guides.set(guides, this.origin);
  }

  getEdgeStyle(): ResolvedEdgeStyle {
    return this.edgeStyle;
  }

  setOrigin(origin: Vec3): void {
    this.origin = origin;
    for (const body of this.lastBodies) {
      const r = this.bodies.get(body.id);
      if (!r) continue;
      r.update(body, origin);
      this.stage(r);
    }
    for (const sketch of this.lastSketches) {
      const r = this.sketches.get(sketch.id);
      if (!r) continue;
      r.update(sketch, origin);
      this.stage(r);
    }
    this.highlight.set(this.highlightState, origin);
    this.preview.set(this.preview.meshes, origin);
    this.importPreview.setOrigin(origin);
    this.guides.set(this.guides.guides, origin);
    this.images.setOrigin(origin);
    this.dimensions.set(this.dimensions.dimensions, origin);
    this.texts.set(this.texts.texts, origin);
    this.applySketchSelection();
    this.updateContextBox();
    this.boundsDirty = true;
    this.refreshSections();
  }

  getOrigin(): Vec3 {
    return this.origin;
  }

  /** World-space bounds of all bodies and sketch geometry (not origin-relative). */
  sceneBounds(): Box3 | null {
    if (!this.boundsDirty) return this.bounds;
    const b = box3Empty();
    for (const body of this.lastBodies) {
      const local = meshBounds(body.mesh);
      if (box3IsEmpty(local)) continue;
      for (const x of [local.min[0], local.max[0]])
        for (const y of [local.min[1], local.max[1]])
          for (const z of [local.min[2], local.max[2]]) box3Expand(b, m4transformPoint(body.transform, [x, y, z]));
    }
    for (const sketch of this.lastSketches) {
      for (const e of sketch.edges) {
        box3Expand(b, e.a);
        box3Expand(b, e.b);
      }
      for (const f of sketch.faces) for (const loop of f.loops) for (const p of loop) box3Expand(b, p);
    }
    for (const image of this.images.images) for (const p of imageCorners(image)) box3Expand(b, p);
    this.bounds = box3IsEmpty(b) ? null : b;
    this.boundsDirty = false;
    return this.bounds;
  }

  setResolution(width: number, height: number, pixelRatio = 1): void {
    for (const m of this.edgeMaterialSets) {
      m.edge.resolution.set(width, height);
      m.hiddenEdge.resolution.set(width, height);
      m.backEdge.resolution.set(width, height);
    }
    this.contextBoxMaterial.resolution.set(width, height);
    this.highlight.setResolution(width, height, pixelRatio);
    this.guides.setResolution(width, height, pixelRatio);
    this.dimensions.setResolution(width, height);
    this.texts.setResolution(width, height);
    this.sections.setResolution(width, height);
  }

  dispose(): void {
    this.batches.dispose();
    for (const r of this.bodies.values()) r.dispose();
    this.bodies.clear();
    for (const r of this.sketches.values()) r.dispose();
    this.sketches.clear();
    this.highlight.dispose();
    this.preview.dispose();
    this.importPreview.dispose();
    this.guides.dispose();
    this.images.dispose();
    this.dimensions.dispose();
    this.texts.dispose();
    this.sections.dispose();
    this.contextBox.geometry.dispose();
    this.contextBoxMaterial.dispose();
    this.root.clear();
    for (const m of this.edgeMaterialSets) {
      m.front.dispose();
      m.back.dispose();
      m.edge.dispose();
      m.hiddenEdge.dispose();
      m.backEdge.dispose();
    }
    this.sketchMaterials.front.dispose();
    this.sketchMaterials.back.dispose();
    this.fadedSketchMaterials.front.dispose();
    this.fadedSketchMaterials.back.dispose();
    this.texturedMaterials.dispose();
    this.textures.dispose();
  }
}

/** Version of a renderable's selection flags (bumped when its tint changes). */
function flagsVersion(r: { readonly front: Mesh }): number | undefined {
  return (r.front.geometry.getAttribute('flags') as BufferAttribute | undefined)?.version;
}
