// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors

import type { MetadataApplyResult } from './metadata.ts';
/**
 * The model document API as `context.model` and `context.selection` use it, version 1. Lengths are meters in
 * right-handed Z-up coordinates, local to the container a request names (the model, or a group or component opened at
 * an instance path); angles are degrees in fields named `...Deg`. Reads are bounded: a query returns at most 200
 * entities per page, and a batch holds at most 200 operations.
 */

export type ModelVec3 = [number, number, number];
export type ModelEntityKind =
  'instance' | 'body' | 'face' | 'edge' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';

/**
 * An entity, as requests name it. Without `path` it is an entity of the container being edited; with one, an entity
 * of the group or component at that instance path, as reads report it, so the refs reads return (`ModelRef`) are
 * accepted as they are. `context.selection.set` and `frame` take entities of any container; a batch's operations
 * take only entities of the batch's own container, except paint_part and transform_part which also accept descendant solids. A face is a face of a body: `id` is the body and `faceId` the
 * face. An edge of a body is named by the `edgeKey` a query gave, valid only for the revision it was read at. A face
 * of a solid can also be chosen without its id, as `{ body, facing, point? }`: `facing` is the face's outward
 * direction (within 1 degree), and `point`, a point on the face, picks one when several face the same way; it must
 * match exactly one face. `"$name"` refers to an entity created earlier in the same batch.
 */
export type ModelRefInput =
  | string
  | {
      kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
      id: number;
      path?: number[] | undefined;
    }
  | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
  | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
  | { body: number | string; facing: ModelVec3; point?: ModelVec3 | undefined };

/** An entity as reads report it: the instance path of its container, its kind and id (and face id for faces, edge key for edges). */
export interface ModelRef {
  path: number[];
  kind: ModelEntityKind;
  id: number;
  faceId?: number;
  edgeKey?: string;
}

export interface ModelBounds {
  min: ModelVec3;
  max: ModelVec3;
}
export interface ModelCameraSummary {
  eye: ModelVec3;
  target: ModelVec3;
  up: ModelVec3;
  projection: 'perspective' | 'parallel';
  fovDeg: number;
  viewHeight: number;
}
export interface ModelSceneSaves {
  camera: boolean;
  hiddenGeometry: boolean;
  hiddenObjects: boolean;
  tags: boolean;
  style: boolean;
  shadows: boolean;
  sectionPlanes: boolean;
  axes: boolean;
}
export interface ModelSceneSummary {
  id: number;
  name: string;
  description: string;
  index: number;
  active: boolean;
  saves: ModelSceneSaves;
  includeInAnimation: boolean;
}
export interface ModelDefinitionSummary {
  id: number;
  name: string;
  type: 'group' | 'component';
  placements: number;
  solids: number;
  faces: number;
  edges: number;
  instances: number;
  bounds: ModelBounds | null;
}
export interface ModelTagSummary {
  id: number;
  name: string;
  visible: boolean;
  color: string;
  active: boolean;
  untagged: boolean;
}
/** Which way a texture image's grain runs: along its width or height, `none` for a pattern with no single direction. */
export type ModelTextureGrain = 'width' | 'height' | 'none';
export interface ModelMaterialSummary {
  id: number;
  name: string;
  color: string;
  opacity: number;
  textured: boolean;
  isDefault: boolean;
  /** Textured materials: which way the image's grain runs; null without a texture. */
  grain: ModelTextureGrain | null;
}

/** What `context.model.read` returns. `selection` is empty unless the extension may read the selection. */
export interface ModelDocumentSnapshot {
  apiVersion: number;
  revision: number;
  /** How to talk to people about lengths; every number in the API stays meters. */
  displayUnits: { format: string; lengthUnit: string; precision: number };
  editContext: { path: number[]; definitionId: number; name: string; worldTransform: number[] };
  selection: ModelRef[];
  bounds: ModelBounds | null;
  definitions: ModelDefinitionSummary[];
  tags: ModelTagSummary[];
  materials: ModelMaterialSummary[];
  scenes: ModelSceneSummary[];
  /** The view of the document's window; null without a viewport. */
  camera: ModelCameraSummary | null;
  playing: boolean;
}

/** A field-selected, bounded read of one container's entities. */
export interface ModelQuery {
  /** null: the container open in the editor. */
  container: number[] | null;
  /** null: every kind except face and edge. Faces and edges of solids are listed only when asked for, per body. */
  kinds: ModelEntityKind[] | null;
  /** null: all. For faces and edges, the body ids whose faces or edges to list. At most 200. */
  ids: number[] | null;
  /** Faces: keep faces whose outward normal is within 1 degree of this direction. Edges: keep edges running this way. */
  facing: ModelVec3 | null;
  /** Faces and edges: keep those that contain this point. */
  containing: ModelVec3 | null;
  /**
   * null: all. bounds: bounding boxes; geometry: transforms, points, normals, areas, volumes and face outlines
   * (`outerLoop` and `holes`, each loop simplified to at most 512 points, with `truncated` set when that happened);
   * appearance: materials and, for textured faces, the visible grain direction.
   */
  fields: ('bounds' | 'geometry' | 'appearance')[] | null;
  offset: number | null;
  /**
   * 1 to 200; null: 50. A page of faces with geometry may end before the limit, once its loops hold 40,000 points;
   * `next` says where to continue.
   */
  limit: number | null;
  projection?: [ModelVec3, ModelVec3, ModelVec3] | null | undefined;
}

export interface ModelEntitySummary {
  element?:
    { kind: 'face'; faceId: number; bodyVersion: number } | { kind: 'edge'; edgeKey: string; bodyVersion: number };

  ref: ModelRef;
  tagId?: number;
  hidden: boolean;
  locked?: boolean;
  bounds?: ModelBounds | null;
  /** Instances. */
  definitionId?: number;
  name?: string;
  transform?: number[];
  /** Instances and solids: the material; faces: the front and back materials. null is the default material. */
  materialId?: number | null;
  frontMaterialId?: number | null;
  backMaterialId?: number | null;
  /**
   * Faces whose front shows a texture: the direction its grain runs, a unit vector in the container's coordinates,
   * or null for a pattern with no grain.
   */
  grain?: ModelVec3 | null;
  /** Faces whose front shows a texture: whether the texture has its default placement (never turned). */
  defaultPlacement?: boolean;
  /** Solids. */
  /** Changes when the body geometry changes; independent of metadata and document revision. */
  geometryVersion?: number;
  referenceFrame?: number[];
  referenceBounds?: ModelBounds;
  projectedBounds?: ModelBounds;
  volume?: number;
  area?: number;
  faceCount?: number;
  /**
   * Faces and sketch faces. `outerLoop` runs counterclockwise about `normal` and each hole in `holes` runs clockwise,
   * so a loop's signed area about the normal is positive for the outline and negative for every hole. Loops are in
   * the container's coordinates and do not repeat their first point. A loop of more than 512 points is simplified to
   * that many, dropping the points that change its outline least, and `truncated` is then true; `loopPointCount` is
   * the outer loop's count before simplification.
   */
  normal?: ModelVec3;
  outerLoop?: ModelVec3[];
  loopPointCount?: number;
  holes?: ModelVec3[][];
  truncated?: boolean;
  /** Sketch edges and edges of solids. */
  start?: ModelVec3;
  /** Edges of solids: their length and the two faces they join. */
  length?: number;
  faces?: [number, number];
  end?: ModelVec3;
  soft?: boolean;
  smooth?: boolean;
  curve?: boolean;
  /** Section planes: whether it cuts the view. */
  active?: boolean;
  /** Guides, texts, dimensions and section planes. */
  points?: ModelVec3[];
  text?: string;
}

export interface ModelQueryResult {
  revision: number;
  container: number[];
  /** Local-to-world transform of the container (column-major 4×4). */
  worldTransform: number[];
  total: number;
  offset: number;
  entities: ModelEntitySummary[];
  /** The offset of the next page, or null on the last one. */
  next: number | null;
}

export type ModelStandardView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

/** A camera: exact, or framed around a subject from a view direction. */
export type ModelCameraInput =
  | {
      mode: 'exact';
      eye: ModelVec3;
      target: ModelVec3;
      up?: ModelVec3 | undefined;
      projection?: 'perspective' | 'parallel' | undefined;
      fovDeg?: number | undefined;
      viewHeight?: number | undefined;
    }
  | {
      mode: 'framed';
      direction?: ModelStandardView | 'current' | undefined;
      orbitDeg?: { horizontal?: number | undefined; vertical?: number | undefined } | undefined;
      subject?: 'model' | 'selection' | 'target' | { refs: ModelRefInput[] } | undefined;
      margin?: number | undefined;
      projection?: 'perspective' | 'parallel' | undefined;
      fovDeg?: number | undefined;
    };

/** A scene id, its name (any letter case), "active", or "$name" of a scene added earlier in the batch. */
export type ModelSceneRef = number | string;
export interface ModelSceneSavesInput {
  camera?: boolean | undefined;
  hiddenGeometry?: boolean | undefined;
  hiddenObjects?: boolean | undefined;
  tags?: boolean | undefined;
  style?: boolean | undefined;
  shadows?: boolean | undefined;
  sectionPlanes?: boolean | undefined;
  axes?: boolean | undefined;
}

/** A face of the operation's solid, chosen by its outward direction: `{ facing, point? }`. It must match exactly one face. */
export interface ModelEdgeFace {
  facing: ModelVec3;
  point?: ModelVec3 | undefined;
}

/**
 * Edges of one solid, found when the operation runs, so choices by face or direction never go stale: an edge key from
 * a query (kind `edge`), the edges bounding a face (`which`: `all`, the default, `outer` for its outline, `inner` for
 * its openings, or `parallel` for those running along `along`, which that choice needs), the edge two faces share,
 * every edge around the face facing a direction, or edges running one way (with `through`, only those through that
 * point). Each must match at least one sharp edge.
 */
export type ModelEdgeSelector =
  | string
  | { face: ModelEdgeFace; which?: 'all' | 'outer' | 'inner' | 'parallel' | undefined; along?: ModelVec3 | undefined }
  | { between: [ModelEdgeFace, ModelEdgeFace] }
  | { faceFacing: ModelVec3; facePoint?: ModelVec3 | undefined }
  | { along: ModelVec3; through?: ModelVec3 | undefined };

/** One operation of a batch. Create operations accept `as`; later operations refer to the result as `"$name"`. */
export type ModelOperation =
  | {
      op: 'follow_me';
      profile:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      as?: string | undefined;
      pathEdges?:
        | (
            | string
            | {
                kind:
                  'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
                id: number;
                path?: number[] | undefined;
              }
            | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
            | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
            | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
          )[]
        | undefined;
      pathPoints?: [number, number, number][] | undefined;
      closed?: boolean | undefined;
    }
  | {
      op: 'chamfer_edges';
      body:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      edges: (
        | string
        | {
            face: { facing: [number, number, number]; point?: [number, number, number] | undefined };
            which?: 'all' | 'outer' | 'inner' | 'parallel' | undefined;
            along?: [number, number, number] | undefined;
          }
        | {
            between: [
              { facing: [number, number, number]; point?: [number, number, number] | undefined },
              { facing: [number, number, number]; point?: [number, number, number] | undefined },
            ];
          }
        | { faceFacing: [number, number, number]; facePoint?: [number, number, number] | undefined }
        | { along: [number, number, number]; through?: [number, number, number] | undefined }
      )[];
      distance: number;
      distance2?: number | undefined;
      angleDeg?: number | undefined;
      reference?: { facing: [number, number, number]; point?: [number, number, number] | undefined } | undefined;
    }
  | {
      op: 'offset';
      distance: number;
      as?: string | undefined;
      face?:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
        | undefined;
      edges?:
        | (
            | string
            | {
                kind:
                  'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
                id: number;
                path?: number[] | undefined;
              }
            | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
            | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
            | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
          )[]
        | undefined;
    }
  | {
      op: 'add_text';
      text: string;
      as?: string | undefined;
      anchor?: [number, number, number] | undefined;
      label?: [number, number, number] | undefined;
      screen?: [number, number] | undefined;
    }
  | {
      op: 'add_material';
      as?: string | undefined;
      name?: string | undefined;
      color?: string | undefined;
      opacity?: number | undefined;
      library?: string | undefined;
    }
  | { op: 'add_edges'; edges: [[number, number, number], [number, number, number]][]; as?: string | undefined }
  | { op: 'add_polyline'; points: [number, number, number][]; as?: string | undefined; closed?: boolean | undefined }
  | {
      op: 'add_rectangle';
      corner: [number, number, number];
      side1: [number, number, number];
      side2: [number, number, number];
      as?: string | undefined;
    }
  | {
      op: 'add_circle';
      center: [number, number, number];
      normal: [number, number, number];
      radius: number;
      as?: string | undefined;
      segments?: number | undefined;
    }
  | {
      op: 'add_polygon';
      center: [number, number, number];
      normal: [number, number, number];
      radius: number;
      sides: number;
      as?: string | undefined;
    }
  | {
      op: 'push_pull';
      face:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      distance: number;
      as?: string | undefined;
      mode?: 'merged' | 'new_body' | undefined;
    }
  | {
      op: 'boolean_part';
      mode: 'union' | 'subtract' | 'intersect';
      target:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      tool:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      as?: string | undefined;
      keepTool?: boolean | undefined;
      scope?: 'placement' | 'shared' | undefined;
    }
  | {
      op: 'union';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      as?: string | undefined;
    }
  | {
      op: 'subtract';
      target:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      cutters: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      as?: string | undefined;
      keepCutters?: boolean | undefined;
    }
  | {
      op: 'intersect';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      as?: string | undefined;
    }
  | {
      op: 'split';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
    }
  | {
      op: 'revolve';
      profile:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      axisOrigin: [number, number, number];
      axisDir: [number, number, number];
      as?: string | undefined;
      angleDeg?: number | undefined;
      segments?: number | undefined;
    }
  | { op: 'add_box'; min: [number, number, number]; max: [number, number, number]; as?: string | undefined }
  | {
      op: 'add_prism';
      points: [number, number, number][];
      normal: [number, number, number];
      distance: number;
      as?: string | undefined;
      holes?: [number, number, number][][] | undefined;
      extrusionDirection?: [number, number, number] | undefined;
      referenceFrame?: number[] | undefined;
      smoothSides?: boolean | undefined;
      closedCurve?: boolean | undefined;
    }
  | {
      op: 'add_part';
      points: [number, number, number][];
      normal: [number, number, number];
      distance: number;
      as?: string | undefined;
      container?: string | number[] | undefined;
      scope?: 'placement' | 'shared' | undefined;
      holes?: [number, number, number][][] | undefined;
      extrusionDirection?: [number, number, number] | undefined;
      referenceFrame?: number[] | undefined;
      smoothSides?: boolean | undefined;
      closedCurve?: boolean | undefined;
      componentName?: string | undefined;
    }
  | {
      op: 'fillet_edges';
      body:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      edges: (
        | string
        | {
            face: { facing: [number, number, number]; point?: [number, number, number] | undefined };
            which?: 'all' | 'outer' | 'inner' | 'parallel' | undefined;
            along?: [number, number, number] | undefined;
          }
        | {
            between: [
              { facing: [number, number, number]; point?: [number, number, number] | undefined },
              { facing: [number, number, number]; point?: [number, number, number] | undefined },
            ];
          }
        | { faceFacing: [number, number, number]; facePoint?: [number, number, number] | undefined }
        | { along: [number, number, number]; through?: [number, number, number] | undefined }
      )[];
      radius: number;
      segments?: number | undefined;
    }
  | {
      op: 'profile_edges';
      body:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      edges: (
        | string
        | {
            face: { facing: [number, number, number]; point?: [number, number, number] | undefined };
            which?: 'all' | 'outer' | 'inner' | 'parallel' | undefined;
            along?: [number, number, number] | undefined;
          }
        | {
            between: [
              { facing: [number, number, number]; point?: [number, number, number] | undefined },
              { facing: [number, number, number]; point?: [number, number, number] | undefined },
            ];
          }
        | { faceFacing: [number, number, number]; facePoint?: [number, number, number] | undefined }
        | { along: [number, number, number]; through?: [number, number, number] | undefined }
      )[];
      profile: 'roundover' | 'cove' | 'ogee' | 'bead' | 'chamfer' | 'step';
      size: number;
      depth?: number | undefined;
      angleDeg?: number | undefined;
      reference?: { facing: [number, number, number]; point?: [number, number, number] | undefined } | undefined;
      segments?: number | undefined;
    }
  | {
      op: 'add_arc';
      center: [number, number, number];
      normal: [number, number, number];
      radius: number;
      startDeg: number;
      endDeg: number;
      as?: string | undefined;
      segments?: number | undefined;
    }
  | { op: 'fillet_corner'; corner: [number, number, number]; radius: number; segments?: number | undefined }
  | {
      op: 'mirror';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      origin: [number, number, number];
      normal: [number, number, number];
      as?: string | undefined;
      copy?: boolean | undefined;
    }
  | {
      op: 'intersect_faces';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      with?:
        | (
            | string
            | {
                kind:
                  'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
                id: number;
                path?: number[] | undefined;
              }
            | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
            | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
            | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
          )[]
        | undefined;
    }
  | {
      op: 'soften_edges';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      angleDeg?: number | undefined;
      smooth?: boolean | undefined;
    }
  | {
      op: 'add_guide';
      point: [number, number, number];
      as?: string | undefined;
      direction?: [number, number, number] | undefined;
      end?: [number, number, number] | undefined;
    }
  | { op: 'add_guides'; segments: [[number, number, number], [number, number, number]][] }
  | {
      op: 'add_dimension';
      start: [number, number, number];
      end: [number, number, number];
      offset: [number, number, number];
      as?: string | undefined;
    }
  | {
      [x: string]: any;
      op: 'add_cabinet';
      type: 'base' | 'wall' | 'tall' | 'vanity';
      width: number;
      as?: string | undefined;
      height?: number | undefined;
      depth?: number | undefined;
      at?: [number, number, number] | undefined;
      frame?: 'frameless' | 'face_frame' | undefined;
      overlay?: 'full' | 'partial' | 'inset' | undefined;
      doorStyle?: 'slab' | 'shaker' | 'raised' | 'glass' | 'beadboard' | 'none' | undefined;
      doors?: number | undefined;
      drawers?: number | undefined;
      drawerBoxes?: boolean | undefined;
      sinkFront?: boolean | undefined;
      shelves?: number | undefined;
      toeKick?: boolean | undefined;
      back?: boolean | undefined;
      finish?: { paint?: string | undefined; roughness?: number | undefined; stain?: string | undefined } | undefined;
      stackedDoors?: boolean | undefined;
      upperDoorHeight?: number | undefined;
      upperDoorStyle?: 'slab' | 'shaker' | 'raised' | 'glass' | 'beadboard' | undefined;
      corner?:
        | {
            style: 'blind' | 'diagonal' | 'l_shaped';
            side?: 'left' | 'right' | undefined;
            returnWidth?: number | undefined;
            blindWidth?: number | undefined;
            lazySusan?: boolean | undefined;
          }
        | undefined;
      glass?:
        | {
            pattern?: 'single' | 'grid' | 'prairie' | 'mission' | undefined;
            across?: number | undefined;
            down?: number | undefined;
            type?: 'clear' | 'frosted' | 'seeded' | 'reeded' | undefined;
          }
        | undefined;
      finishedInterior?: boolean | undefined;
      boxFinish?:
        { paint?: string | undefined; roughness?: number | undefined; library?: string | undefined } | undefined;
      beadedFrame?: boolean | undefined;
      drawerFronts?: 'slab' | 'auto' | 'match' | undefined;
      hardware?: 'none' | 'bar' | 'knob' | undefined;
      hardwareFinish?: string | undefined;
      finishedEnds?: 'none' | 'left' | 'right' | 'both' | undefined;
      name?: string | undefined;
    }
  | { op: 'build'; builder: any; params: Record<string, unknown>; as?: string | undefined }
  | {
      op: 'add_3d_text';
      text: string;
      position: [number, number, number];
      as?: string | undefined;
      height?: number | undefined;
      extrude?: number | undefined;
      font?: 'sans' | 'serif' | 'mono' | undefined;
      bold?: boolean | undefined;
      align?: 'center' | 'left' | 'right' | undefined;
    }
  | {
      op: 'add_section_plane';
      point: [number, number, number];
      normal: [number, number, number];
      as?: string | undefined;
      name?: string | undefined;
      active?: boolean | undefined;
    }
  | {
      op: 'set_section_plane';
      plane: string | number;
      active?: boolean | undefined;
      hidden?: boolean | undefined;
      reverse?: boolean | undefined;
    }
  | {
      op: 'set_material';
      materialId: string | number;
      name?: string | undefined;
      color?: string | undefined;
      opacity?: number | undefined;
    }
  | { op: 'add_material_appearance'; asset: string; as?: string | undefined; name?: string | undefined }
  | { op: 'set_material_appearance'; asset: string; materialId: string | number }
  | { op: 'duplicate_material'; materialId: string | number; as?: string | undefined; name?: string | undefined }
  | { op: 'remove_material'; materialId: string | number }
  | { op: 'purge_materials' }
  | {
      op: 'set_texture';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      grain: [number, number, number] | null;
    }
  | {
      op: 'make_group';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      as?: string | undefined;
    }
  | {
      op: 'make_component';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      as?: string | undefined;
      name?: string | undefined;
    }
  | {
      op: 'explode';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
    }
  | {
      op: 'make_unique';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
    }
  | {
      op: 'place_component';
      definitionId: string | number;
      position: [number, number, number];
      as?: string | undefined;
    }
  | {
      op: 'transform';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      matrix: number[];
      as?: string | undefined;
      copy?: boolean | undefined;
    }
  | {
      op: 'move';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      offset: [number, number, number];
      as?: string | undefined;
      copy?: boolean | undefined;
      copies?: number | undefined;
    }
  | {
      op: 'rotate';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      origin: [number, number, number];
      axis: [number, number, number];
      angleDeg: number;
      as?: string | undefined;
      copy?: boolean | undefined;
      copies?: number | undefined;
    }
  | {
      op: 'scale';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      origin: [number, number, number];
      factors: [number, number, number];
      as?: string | undefined;
      copy?: boolean | undefined;
    }
  | {
      op: 'rename_instance';
      ref:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      name: string;
    }
  | { op: 'rename_definition'; definitionId: string | number; name: string }
  | {
      op: 'set_hidden';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      hidden: boolean;
    }
  | {
      op: 'set_locked';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      locked: boolean;
    }
  | {
      op: 'delete';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
    }
  | { op: 'add_tag'; as?: string | undefined; name?: string | undefined; color?: string | undefined }
  | {
      op: 'assign_tag';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      tagId: string | number;
    }
  | {
      op: 'set_tag';
      tagId: string | number;
      visible?: boolean | undefined;
      color?: string | undefined;
      name?: string | undefined;
    }
  | {
      op: 'transform_part';
      ref:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      worldMatrix: number[];
    }
  | {
      op: 'place_fragment';
      fragment: string;
      worldMatrix: number[];
      as?: string | undefined;
      container?: string | number[] | undefined;
      independent?: boolean | undefined;
    }
  | {
      op: 'copy_physical';
      ref:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      worldMatrix: number[];
      as?: string | undefined;
      container?: string | number[] | undefined;
      independent?: boolean | undefined;
    }
  | {
      op: 'stretch_physical';
      ref:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      planes: {
        normal: [number, number, number];
        offset: number;
        side: 'positive' | 'negative';
        displacement: [number, number, number];
      }[];
      as?: string | undefined;
      scope?: 'placement' | 'shared' | undefined;
      anchor?: [number, number, number] | undefined;
    }
  | {
      op: 'copy_part';
      ref:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      worldMatrix: number[];
      as?: string | undefined;
      container?: string | number[] | undefined;
    }
  | {
      op: 'paint_part';
      ref:
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined };
      materialId: string | number | null;
      scope: 'placement' | 'shared';
    }
  | {
      op: 'paint';
      refs: (
        | string
        | {
            kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';
            id: number;
            path?: number[] | undefined;
          }
        | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
        | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
        | { body: string | number; facing: [number, number, number]; point?: [number, number, number] | undefined }
      )[];
      materialId: string | number | null;
      side?: 'back' | 'both' | 'front' | undefined;
      recursive?: boolean | undefined;
    }
  | {
      op: 'add_scene';
      as?: string | undefined;
      name?: string | undefined;
      description?: string | undefined;
      saves?:
        | {
            camera?: boolean | undefined;
            hiddenGeometry?: boolean | undefined;
            hiddenObjects?: boolean | undefined;
            tags?: boolean | undefined;
            style?: boolean | undefined;
            shadows?: boolean | undefined;
            sectionPlanes?: boolean | undefined;
            axes?: boolean | undefined;
          }
        | undefined;
      includeInAnimation?: boolean | undefined;
      camera?:
        | {
            mode: 'exact';
            eye: [number, number, number];
            target: [number, number, number];
            up?: [number, number, number] | undefined;
            projection?: 'parallel' | 'perspective' | undefined;
            fovDeg?: number | undefined;
            viewHeight?: number | undefined;
          }
        | {
            mode: 'framed';
            direction?: 'back' | 'left' | 'right' | 'front' | 'top' | 'bottom' | 'iso' | 'current' | undefined;
            orbitDeg?: { horizontal?: number | undefined; vertical?: number | undefined } | undefined;
            subject?:
              | 'target'
              | 'model'
              | 'selection'
              | {
                  refs: (
                    | string
                    | {
                        kind:
                          | 'instance'
                          | 'body'
                          | 'sketchEdge'
                          | 'sketchFace'
                          | 'guide'
                          | 'text'
                          | 'dimension'
                          | 'sectionPlane';
                        id: number;
                        path?: number[] | undefined;
                      }
                    | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
                    | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
                    | {
                        body: string | number;
                        facing: [number, number, number];
                        point?: [number, number, number] | undefined;
                      }
                  )[];
                }
              | undefined;
            margin?: number | undefined;
            projection?: 'parallel' | 'perspective' | undefined;
            fovDeg?: number | undefined;
          }
        | undefined;
    }
  | {
      op: 'update_scene';
      scene: string | number;
      camera?:
        | {
            mode: 'exact';
            eye: [number, number, number];
            target: [number, number, number];
            up?: [number, number, number] | undefined;
            projection?: 'parallel' | 'perspective' | undefined;
            fovDeg?: number | undefined;
            viewHeight?: number | undefined;
          }
        | {
            mode: 'framed';
            direction?: 'back' | 'left' | 'right' | 'front' | 'top' | 'bottom' | 'iso' | 'current' | undefined;
            orbitDeg?: { horizontal?: number | undefined; vertical?: number | undefined } | undefined;
            subject?:
              | 'target'
              | 'model'
              | 'selection'
              | {
                  refs: (
                    | string
                    | {
                        kind:
                          | 'instance'
                          | 'body'
                          | 'sketchEdge'
                          | 'sketchFace'
                          | 'guide'
                          | 'text'
                          | 'dimension'
                          | 'sectionPlane';
                        id: number;
                        path?: number[] | undefined;
                      }
                    | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
                    | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
                    | {
                        body: string | number;
                        facing: [number, number, number];
                        point?: [number, number, number] | undefined;
                      }
                  )[];
                }
              | undefined;
            margin?: number | undefined;
            projection?: 'parallel' | 'perspective' | undefined;
            fovDeg?: number | undefined;
          }
        | undefined;
      saves?:
        | {
            camera?: boolean | undefined;
            hiddenGeometry?: boolean | undefined;
            hiddenObjects?: boolean | undefined;
            tags?: boolean | undefined;
            style?: boolean | undefined;
            shadows?: boolean | undefined;
            sectionPlanes?: boolean | undefined;
            axes?: boolean | undefined;
          }
        | undefined;
      recapture?: boolean | undefined;
    }
  | { op: 'delete_scene'; scene: string | number }
  | { op: 'rename_scene'; scene: string | number; name?: string | undefined; description?: string | undefined }
  | { op: 'move_scene'; scene: string | number; index: number }
  | { op: 'set_scene_animation'; scene: string | number; include: boolean };
export type ModelOperationName = ModelOperation['op'];

/** One atomic edit: every operation applies, or none does, as one undo entry named after the extension. */
export interface ModelBatch {
  /** The revision of the last read; a batch against an older one fails with `revision.stale`. */
  expectedRevision: number;
  /** The group or component to edit, as an instance path. Default: the container open in the editor. */
  container?: number[] | undefined;
  /** Short undo label, such as "Group the shelves". */
  label: string;
  operations: ModelOperation[];
}

/** A face an operation left as it was, and why. */
export interface ModelSkipped {
  ref: ModelRef;
  reason: 'no_texture' | 'no_grain' | 'end_grain';
}
/** What an `as` name of an earlier batch names: its kind and id, and a group's or placement's definition. */
export interface ModelNameEntry {
  kind: string;
  id: number;
  definitionId?: number;
}

export interface ModelBuilderPart {
  name: string;
  id: number;
  path: number[];
  size?: [number, number, number];
  copies?: number;
}

export interface ModelBatchResult {
  /** Changes from an optional same-transaction metadata edit. */
  metadata?: MetadataApplyResult | undefined;
  ok: true;
  revision: number;
  label: string;
  /** `as` names this batch gave, and the ids they got. */
  created: Record<string, number>;
  /**
   * Names from earlier batches that still name something, with what they name; with `created`, every name a later
   * batch may use. Absent when there are none.
   */
  names?: Record<string, ModelNameEntry>;
  /** Names this batch gave that an earlier batch had given to something else; they now mean the new result. */
  rebound?: string[];
  /** Names dropped since the last batch because the batch that gave them was undone. */
  dropped?: string[];
  /**
   * Per operation: `id` is the main result (a new solid, the face a shape made, a group's instance), `refs` what it
   * created or changed, and `deleted` what it removed, such as the cutters of a subtract.
   */
  results: {
    op: ModelOperationName;
    id?: number;
    definitionId?: number;
    refs?: ModelRef[];
    deleted?: ModelRef[];
    count?: number;
    name?: string;
    skipped?: ModelSkipped[];
    used?: unknown;
    parts?: ModelBuilderPart[];
  }[];
}

/** The units PushForm shows a document's lengths in. Every number in the API stays meters. */
export interface DocumentUnits {
  system: 'metric' | 'imperial';
  lengthUnit: 'mm' | 'cm' | 'm' | 'in' | 'ft';
  format: 'decimal' | 'architectural' | 'fractional' | 'engineering';
  /** Decimals for decimal and engineering formats; the power of two of the smallest fraction (3 for 1/8) otherwise. */
  lengthPrecision: number;
}

/** Told when a document's units change, or the extension starts acting on another document. */
export interface DocumentUnitsEvent {
  /** The handle of the document whose units these are. */
  document: string;
  units: DocumentUnits;
}

/** What `context.document.info` returns: the document as the user sees it. */
export interface DocumentInfo {
  /** The document's name as its tab shows it: the file name without its extension, or an untitled name. */
  name: string;
  units: DocumentUnits;
}

/** Told when a document's name or units change, or the extension starts acting on another document. */
export interface DocumentInfoEvent extends DocumentInfo {
  /** The handle of the document this describes. */
  document: string;
}

/** Told when a document the extension subscribed to changes. */
export interface ModelChangeEvent {
  document: string;
  revision: number;
  /** The model itself, or the selection (only with `selection.read`). */
  changes: ('model' | 'selection')[];
}
