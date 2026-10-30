// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import { BackSide, BufferAttribute, BufferGeometry, Color, FrontSide, Group, Mesh, MeshLambertMaterial, ShaderChunk, Vector2 } from 'three';
import type { Material, WebGLProgramParametersWithUniforms } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import type { RenderBody, RenderFaceGroup, RenderPath, RenderFaceCamera } from '../types';
import { EMPTY_SEGMENTS } from '../types';
import { buildBodyEdgeSegments, buildFaceArrays, extractEdgeSegments, meshFaceNormals, transformedVerts } from './buildGeometry';
import type { TexturedMaterialCache } from '../materials/TextureCache';
import { needsOwnMaterial } from '../materials/TextureCache';
import { EdgeBatch } from './EdgeBatch';
import { createEdgeMaterial, DEFAULT_EDGE_WIDTH, DEFAULT_PROFILE_WIDTH } from './EdgeMaterial';
import type { EdgeMaterial } from './EdgeMaterial';
import { palette } from './palette';

/** Default style colors. */
export { FRONT_COLOR, BACK_COLOR, SELECT_COLOR } from './palette';
/** Face opacity of entities outside the open edit context ("fade rest of model"). */
export const FADE_OPACITY = 0.35;
/** Edge color of faded entities. */
export const FADED_EDGE_COLOR = 0x9ca3af;
/** Edge opacity of faded entities. */
export const FADED_EDGE_OPACITY = 0.6;

export interface BodyMaterials {
  readonly front: MeshLambertMaterial;
  readonly back: MeshLambertMaterial;
  /** Shared edge material (normal + profile widths). */
  readonly edge: EdgeMaterial;
  /** Dashed variant for soft/hidden edges when hidden geometry is shown. */
  readonly hiddenEdge: EdgeMaterial;
  /** Back-edges pass: thin dashed edges drawn only where obscured (`GreaterDepth`); hidden by default. */
  readonly backEdge: EdgeMaterial;
}

/** Shadows › Display "On Faces": when off, faces never receive shadows (set by `Viewport.setShadows`). */
export const shadowDisplay = { onFaces: true };

/**
 * Hidden line with shadows on faces: with `x` 1, faces keep their flat color where the sun reaches
 * them and are multiplied by `y` (linear) where they are in shadow or turned away from it, with no other
 * shading. Shared by every patched material; set by `SceneSync`.
 */
export const hiddenLineShade = { value: new Vector2(0, 1) };

/** Dashed grey of hidden-geometry edges. */
export const HIDDEN_EDGE_COLOR = 0x6b7280;
/** Back edges draw in the edge color at a lighter weight. */
export const BACK_EDGE_COLOR = 0x5b6470;

/** Face material options shared by bodies, sketch faces and previews. */
export const FACE_MATERIAL_COMMON = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 } as const;

/**
 * Selection tint through the per-vertex `flags` attribute: vertices with flags >= 1 are mixed
 * toward the selection color in the fragment shader, so highlighting a body never rebuilds its
 * geometry. Applied with `onBeforeCompile` (works on any built-in material). The same patch makes
 * a texture map projective: the optional `uvq` attribute is the divisor minus one (0, an affine
 * placement, when a geometry has none), and the map is sampled at (s'/q, t'/q) per fragment.
 */
export function patchSelectTint(material: Material, color?: number): void {
  // The palette's color is shared by reference, so a style's selection color reaches every material without a rebuild.
  const tint = color === undefined ? palette.select : new Color(color);
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms['uPfSelectColor'] = { value: tint };
    shader.uniforms['uPfHiddenShade'] = hiddenLineShade;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float flags;\nvarying float vPfFlags;\nattribute float uvq;\nvarying float vPfUvQ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPfFlags = flags;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPfUvQ = 1.0 + uvq;\n#ifdef USE_MAP\nvMapUv = ( mapTransform * vec3( MAP_UV, vPfUvQ ) ).xy;\n#endif');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uPfSelectColor;\nuniform vec2 uPfHiddenShade;\nvarying float vPfFlags;\nvarying float vPfUvQ;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
if ( uPfHiddenShade.x > 0.5 ) {
  vec3 pfSun = reflectedLight.directDiffuse;
  float pfLit = step( 1e-5, max( pfSun.r, max( pfSun.g, pfSun.b ) ) );
  reflectedLight.directDiffuse = vec3( 0.0 );
  reflectedLight.indirectDiffuse = diffuseColor.rgb * mix( uPfHiddenShade.y, 1.0, pfLit );
}`)
      .replace('#include <map_fragment>', ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', 'texture2D( map, vMapUv / vPfUvQ )'))
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\nif ( vPfFlags >= 0.5 ) diffuseColor.rgb = mix( diffuseColor.rgb, uPfSelectColor, 0.25 );',
      );
  };
  material.customProgramCacheKey = () => 'pf-select-tint';
}

export interface BodyMaterialOptions {
  /**
   * Faded set for entities outside the open edit context: translucent faces that still write
   * depth (so context geometry is occluded correctly) and grey, lighter edges.
   */
  readonly faded?: boolean | undefined;
}

/**
 * Shared body materials. Faces are vertex-colored (white material × per-vertex `color`) so a body
 * can carry its own default color (body / instance material) without a material per body; the
 * face style switches `vertexColors` off for monochrome and hidden line.
 */
export function createBodyMaterials(opts: BodyMaterialOptions = {}): BodyMaterials {
  const faded = opts.faded ?? false;
  const faceOpts = faded ? { transparent: true, opacity: FADE_OPACITY, depthWrite: true } : {};
  const front = new MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: FrontSide, ...FACE_MATERIAL_COMMON, ...faceOpts });
  const back = new MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: BackSide, ...FACE_MATERIAL_COMMON, ...faceOpts });
  patchSelectTint(front);
  patchSelectTint(back);
  // `vertexColors` lets Color-by-Tag segments (EDGE_FLAG_COLORED) carry their own color; EdgeBatch
  // always uploads per-segment colors (white = material color) so every user of these materials is safe.
  const edgeOpts = faded ? { color: FADED_EDGE_COLOR, opacity: FADED_EDGE_OPACITY, vertexColors: true } : { vertexColors: true };
  return {
    front,
    back,
    edge: createEdgeMaterial({ width: DEFAULT_EDGE_WIDTH, profileWidth: DEFAULT_PROFILE_WIDTH, ...edgeOpts }),
    hiddenEdge: createEdgeMaterial({ width: DEFAULT_EDGE_WIDTH, profileWidth: DEFAULT_EDGE_WIDTH, dashed: true, color: HIDDEN_EDGE_COLOR, ...edgeOpts }),
    backEdge: Object.assign(
      createEdgeMaterial({ width: DEFAULT_EDGE_WIDTH, profileWidth: DEFAULT_EDGE_WIDTH, dashed: true, color: BACK_EDGE_COLOR, backEdges: true, ...edgeOpts }),
      { visible: false },
    ),
  };
}

/** A `color` attribute (one RGB per vertex) filled with `css` (or the fallback hex when undefined). */
export function fillColorAttribute(vertexCount: number, css: string | undefined, fallback: number): BufferAttribute {
  const c = css ? new Color(css) : new Color(fallback);
  const arr = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  return new BufferAttribute(arr, 3);
}

/** Set every entry of a geometry's `flags` attribute (selection tint) and upload it. */
export function fillFlags(geometry: BufferGeometry, value: number, start = 0, count = -1): void {
  const attr = geometry.getAttribute('flags') as BufferAttribute | undefined;
  if (!attr) return;
  const arr = attr.array as Uint8Array;
  const end = count < 0 ? arr.length : Math.min(arr.length, start + count);
  let changed = false;
  for (let i = start; i < end; i++) {
    if (arr[i] !== value) {
      arr[i] = value;
      changed = true;
    }
  }
  if (changed) attr.needsUpdate = true;
}

/**
 * One body: front mesh + back mesh over a shared unwelded geometry (separate `color` attributes
 * carrying the body's default color), a solid edge batch, a dashed batch for soft/hidden edges
 * (hidden-geometry mode) and a back-edges pass sharing the solid batch's geometry (visibility
 * through the shared `backEdge` material). Keyed by the body's render key (`path/entityId`).
 */
export class BodyRenderable extends Group {
  readonly front: Mesh<BufferGeometry, MeshLambertMaterial>;
  readonly back: Mesh<BufferGeometry, MeshLambertMaterial>;
  readonly edges: EdgeBatch;
  readonly hiddenEdges: EdgeBatch;
  readonly backEdges: LineSegments2;
  /** Always Face Camera turn applied each frame by `SceneSync.updateFaceCamera`; never part of the geometry. */
  faceCamera: RenderFaceCamera | undefined = undefined;
  /** Instance path of the body's container (from the last `update`). */
  path: RenderPath = [];
  entityId = -1;
  version: number | undefined;
  meshRef: RenderBody['mesh'] | null = null;
  transformRef: RenderBody['transform'] | null = null;
  edgesRef: RenderBody['edges'] | null = null;
  surfacesRef: RenderBody['surfaces'] | null = null;
  defaultColorRef: string | undefined;
  faceMaterialsRef: RenderBody['faceMaterials'] | null = null;
  hiddenFacesRef: RenderBody['hiddenFaces'] | null = null;
  private selected = false;
  private showHidden = false;
  private builtShowHidden = false;
  private _faded = false;
  private shared: Pick<BodyMaterials, 'front' | 'back'>;
  private frontGroups: readonly RenderFaceGroup[] = [];
  private backGroups: readonly RenderFaceGroup[] = [];
  private _textured = true;

  constructor(
    readonly key: string,
    materials: Pick<BodyMaterials, 'front' | 'back' | 'edge' | 'hiddenEdge' | 'backEdge'>,
    /** Materials for textured / translucent face groups (none = every face uses the shared materials). */
    private readonly texturedCache: TexturedMaterialCache | null = null,
  ) {
    super();
    this.shared = materials;
    this.name = `Body:${key}`;
    this.front = new Mesh(new BufferGeometry(), materials.front);
    this.back = new Mesh(new BufferGeometry(), materials.back);
    this.front.name = 'faces';
    this.back.name = 'backfaces';
    this.front.userData['key'] = key;
    this.back.userData['key'] = key;
    this.edges = new EdgeBatch(materials.edge);
    this.hiddenEdges = new EdgeBatch(materials.hiddenEdge);
    this.hiddenEdges.visible = false;
    this.backEdges = new LineSegments2(this.edges.geometry, materials.backEdge);
    this.backEdges.name = 'BackEdges';
    this.backEdges.frustumCulled = false;
    this.backEdges.renderOrder = 1;
    this.add(this.front, this.back, this.edges, this.hiddenEdges, this.backEdges);
  }

  /** Swap the shared material set (normal ↔ faded). */
  setMaterials(materials: Pick<BodyMaterials, 'front' | 'back' | 'edge' | 'hiddenEdge' | 'backEdge'>, faded: boolean): void {
    this.shared = materials;
    this.edges.material = materials.edge;
    this.hiddenEdges.material = materials.hiddenEdge;
    this.backEdges.material = materials.backEdge;
    this._faded = faded;
    this.applyGroups();
  }

  get isFaded(): boolean {
    return this._faded;
  }

  /** Textured face style on/off: textured groups use their map material or fall back to the shared vertex colors. */
  setTextured(on: boolean): void {
    if (this._textured === on) return;
    this._textured = on;
    this.applyGroups();
  }

  get isTextured(): boolean {
    return this._textured;
  }

  /**
   * Assign the face draw groups: without per-face material groups the meshes use the shared
   * materials; with groups, index 0 is the shared material and every textured / translucent
   * material gets its own index from the cache (textures only while `textured`).
   */
  private applyGroups(): void {
    const apply = (mesh: Mesh<BufferGeometry, MeshLambertMaterial>, groups: readonly RenderFaceGroup[], side: 'front' | 'back') => {
      const shared = this.shared[side];
      const g = mesh.geometry;
      g.clearGroups();
      if (groups.length === 0 || !this.texturedCache) {
        mesh.material = shared;
        return;
      }
      const list: MeshLambertMaterial[] = [shared];
      const index = new Map<MeshLambertMaterial, number>([[shared, 0]]);
      for (const grp of groups) {
        let mat = shared;
        if (needsOwnMaterial(grp.material, this._textured)) mat = this.texturedCache.get(grp.material, side, this._faded, this._textured);
        let i = index.get(mat);
        if (i === undefined) {
          i = list.length;
          list.push(mat);
          index.set(mat, i);
        }
        g.addGroup(grp.start, grp.count, i);
      }
      (mesh as Mesh<BufferGeometry, MeshLambertMaterial | MeshLambertMaterial[]>).material = list;
    };
    apply(this.front, this.frontGroups, 'front');
    apply(this.back, this.backGroups, 'back');
  }

  update(body: RenderBody, origin: Vec3): void {
    const arrays = buildFaceArrays(body.mesh, body.transform, origin, { smoothGroups: body.surfaces, faceMaterials: body.faceMaterials,
      defaultColor: body.defaultColor, hiddenFaces: this.showHidden ? undefined : body.hiddenFaces });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(arrays.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(arrays.normals, 3));
    geometry.setAttribute('faceId', new BufferAttribute(arrays.faceIds, 1));
    geometry.setAttribute('flags', new BufferAttribute(arrays.flags, 1));
    geometry.setAttribute('uv', new BufferAttribute(arrays.uvs, 2));
    geometry.setAttribute('uvq', new BufferAttribute(arrays.uvqs, 1));
    geometry.setAttribute('color', new BufferAttribute(arrays.frontColors, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const backGeometry = new BufferGeometry();
    for (const name of ['position', 'normal', 'faceId', 'flags'] as const) backGeometry.setAttribute(name, geometry.getAttribute(name));
    backGeometry.setAttribute('uv', new BufferAttribute(arrays.uvsBack, 2));
    backGeometry.setAttribute('uvq', new BufferAttribute(arrays.uvqsBack, 1));
    backGeometry.setAttribute('color', new BufferAttribute(arrays.backColors, 3));
    this.frontGroups = arrays.frontGroups;
    this.backGroups = arrays.backGroups;
    backGeometry.boundingBox = geometry.boundingBox;
    backGeometry.boundingSphere = geometry.boundingSphere;
    this.front.geometry.dispose();
    this.front.geometry = geometry;
    this.back.geometry.dispose();
    this.back.geometry = backGeometry;
    this.applyGroups();
    this.path = body.path;
    this.entityId = body.entityId;
    // Shadows: per-entity cast/receive flags (effective only while `renderer.shadowMap` is enabled).
    this.front.castShadow = body.castShadows !== false;
    this.back.castShadow = body.castShadows !== false;
    this.front.receiveShadow = shadowDisplay.onFaces && body.receiveShadows !== false;
    this.back.receiveShadow = shadowDisplay.onFaces && body.receiveShadows !== false;
    this.front.userData['receiveShadows'] = body.receiveShadows !== false;
    this.back.userData['receiveShadows'] = body.receiveShadows !== false;
    this.front.userData['path'] = body.path;
    this.front.userData['entityId'] = body.entityId;
    this.back.userData['path'] = body.path;
    this.back.userData['entityId'] = body.entityId;
    const world = transformedVerts(body.mesh, body.transform, origin);
    if (body.edges) {
      const segs = buildBodyEdgeSegments(body.edges, meshFaceNormals(body.mesh, world), body.transform, origin, { showHidden: this.showHidden });
      this.edges.setSegments(segs.edges);
      this.hiddenEdges.setSegments(segs.hiddenEdges);
    } else {
      this.edges.setSegments(extractEdgeSegments(body.mesh, world));
      this.hiddenEdges.setSegments(EMPTY_SEGMENTS);
    }
    this.hiddenEdges.visible = this.showHidden && this.hiddenEdges.segmentCount > 0;
    this.backEdges.geometry = this.edges.geometry;
    this.backEdges.visible = this.edges.visible;
    this.version = body.version;
    this.meshRef = body.mesh;
    this.transformRef = body.transform;
    this.edgesRef = body.edges;
    this.surfacesRef = body.surfaces;
    this.defaultColorRef = body.defaultColor;
    this.faceMaterialsRef = body.faceMaterials;
    this.hiddenFacesRef = body.hiddenFaces;
    this.builtShowHidden = this.showHidden;
    if (this.selected) fillFlags(geometry, 1);
  }

  needsUpdate(body: RenderBody): boolean {
    if (body.hiddenFaces !== this.hiddenFacesRef) return true;
    if (body.transform !== this.transformRef || body.edges !== this.edgesRef || body.surfaces !== this.surfacesRef) return true;
    if (body.defaultColor !== this.defaultColorRef || body.faceMaterials !== this.faceMaterialsRef) return true;
    if ((body.castShadows !== false) !== this.front.castShadow || (shadowDisplay.onFaces && body.receiveShadows !== false) !== this.front.receiveShadow) return true;
    if (this.showHidden !== this.builtShowHidden) return true;
    if (body.version !== undefined) return body.version !== this.version;
    return body.mesh !== this.meshRef;
  }

  /** Hidden-geometry mode; the next `update` rebuilds the edge batches (soft/hidden edges added or dropped). */
  setShowHidden(on: boolean): boolean {
    if (this.showHidden === on) return false;
    this.showHidden = on;
    return true;
  }

  /** Tint the whole body via the `flags` attribute (no geometry rebuild). */
  setSelected(selected: boolean): void {
    if (this.selected === selected) return;
    this.selected = selected;
    fillFlags(this.front.geometry, selected ? 1 : 0);
  }

  get isSelected(): boolean {
    return this.selected;
  }

  dispose(): void {
    this.front.geometry.dispose();
    this.back.geometry.dispose();
    this.edges.geometry.dispose();
    this.hiddenEdges.geometry.dispose();
  }
}
