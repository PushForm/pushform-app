// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors

/**
 * The model document API as `context.model` and `context.selection` use it, version 1. Lengths are meters in
 * right-handed Z-up coordinates, local to the container a request names (the model, or a group or component opened at
 * an instance path); angles are degrees in fields named `...Deg`. Reads are bounded: a query returns at most 200
 * entities per page, and a batch holds at most 200 operations.
 */

export type ModelVec3 = [number, number, number];
export type ModelEntityKind = 'instance' | 'body' | 'face' | 'edge' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane';

/**
 * An entity, as requests name it. Without `path` it is an entity of the container being edited; with one, an entity
 * of the group or component at that instance path, as reads report it, so the refs reads return (`ModelRef`) are
 * accepted as they are. `context.selection.set` and `frame` take entities of any container; a batch's operations
 * take only entities of the batch's own container. A face is a face of a body: `id` is the body and `faceId` the
 * face. An edge of a body is named by the `edgeKey` a query gave, valid only for the revision it was read at. A face
 * of a solid can also be chosen without its id, as `{ body, facing, point? }`: `facing` is the face's outward
 * direction (within 1 degree), and `point`, a point on the face, picks one when several face the same way; it must
 * match exactly one face. `"$name"` refers to an entity created earlier in the same batch.
 */
export type ModelRefInput = string
  | { kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension' | 'sectionPlane'; id: number; path?: number[] | undefined }
  | { kind: 'face'; id: number; faceId: number; path?: number[] | undefined }
  | { kind: 'edge'; id: number; edgeKey: string; path?: number[] | undefined }
  | { body: number | string; facing: ModelVec3; point?: ModelVec3 | undefined };

/** An entity as reads report it: the instance path of its container, its kind and id (and face id for faces, edge key for edges). */
export interface ModelRef { path: number[]; kind: ModelEntityKind; id: number; faceId?: number; edgeKey?: string }

export interface ModelBounds { min: ModelVec3; max: ModelVec3 }
export interface ModelCameraSummary { eye: ModelVec3; target: ModelVec3; up: ModelVec3; projection: 'perspective' | 'parallel'; fovDeg: number; viewHeight: number }
export interface ModelSceneSaves { camera: boolean; hiddenGeometry: boolean; hiddenObjects: boolean; tags: boolean; style: boolean; shadows: boolean; sectionPlanes: boolean; axes: boolean }
export interface ModelSceneSummary { id: number; name: string; description: string; index: number; active: boolean; saves: ModelSceneSaves; includeInAnimation: boolean }
export interface ModelDefinitionSummary { id: number; name: string; type: 'group' | 'component'; placements: number; solids: number; faces: number; edges: number; instances: number; bounds: ModelBounds | null }
export interface ModelTagSummary { id: number; name: string; visible: boolean; color: string; active: boolean; untagged: boolean }
/** Which way a texture image's grain runs: along its width or height, `none` for a pattern with no single direction. */
export type ModelTextureGrain = 'width' | 'height' | 'none';
export interface ModelMaterialSummary {
  id: number; name: string; color: string; opacity: number; textured: boolean; isDefault: boolean;
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
}

export interface ModelEntitySummary {
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
export type ModelCameraInput = {
  mode: 'exact';
  eye: ModelVec3;
  target: ModelVec3;
  up?: ModelVec3 | undefined;
  projection?: 'perspective' | 'parallel' | undefined;
  fovDeg?: number | undefined;
  viewHeight?: number | undefined;
} | {
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
  camera?: boolean | undefined; hiddenGeometry?: boolean | undefined; hiddenObjects?: boolean | undefined; tags?: boolean | undefined;
  style?: boolean | undefined; shadows?: boolean | undefined; sectionPlanes?: boolean | undefined; axes?: boolean | undefined;
}

/** A face of the operation's solid, chosen by its outward direction: `{ facing, point? }`. It must match exactly one face. */
export interface ModelEdgeFace { facing: ModelVec3; point?: ModelVec3 | undefined }

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
  | { op: 'add_edges'; as?: string | undefined; edges: [ModelVec3, ModelVec3][] }
  | { op: 'add_polyline'; as?: string | undefined; points: ModelVec3[]; closed?: boolean | undefined }
  | { op: 'add_rectangle'; as?: string | undefined; corner: ModelVec3; side1: ModelVec3; side2: ModelVec3 }
  | { op: 'add_circle'; as?: string | undefined; center: ModelVec3; normal: ModelVec3; radius: number; segments?: number | undefined }
  | { op: 'add_polygon'; as?: string | undefined; center: ModelVec3; normal: ModelVec3; radius: number; sides: number }
  | { op: 'push_pull'; as?: string | undefined; face: ModelRefInput; distance: number; mode?: 'merged' | 'new_body' | undefined }
  | { op: 'union'; as?: string | undefined; refs: ModelRefInput[] }
  | { op: 'subtract'; as?: string | undefined; target: ModelRefInput; cutters: ModelRefInput[]; keepCutters?: boolean | undefined }
  | { op: 'intersect'; as?: string | undefined; refs: ModelRefInput[] }
  | { op: 'split'; refs: ModelRefInput[] }
  | { op: 'follow_me'; as?: string | undefined; profile: ModelRefInput; pathEdges?: ModelRefInput[] | undefined; pathPoints?: ModelVec3[] | undefined; closed?: boolean | undefined }
  | { op: 'add_box'; as?: string | undefined; min: ModelVec3; max: ModelVec3 }
  | { op: 'fillet_edges'; body: ModelRefInput; edges: ModelEdgeSelector[]; radius: number; segments?: number | undefined }
  | { op: 'chamfer_edges'; body: ModelRefInput; edges: ModelEdgeSelector[]; distance: number; distance2?: number | undefined; angleDeg?: number | undefined; reference?: ModelEdgeFace | undefined }
  | { op: 'profile_edges'; body: ModelRefInput; edges: ModelEdgeSelector[]; profile: 'roundover' | 'cove' | 'ogee' | 'bead' | 'chamfer' | 'step'; size: number;
    depth?: number | undefined; angleDeg?: number | undefined; reference?: ModelEdgeFace | undefined; segments?: number | undefined }
  | { op: 'add_arc'; as?: string | undefined; center: ModelVec3; normal: ModelVec3; radius: number; startDeg: number; endDeg: number; segments?: number | undefined }
  | { op: 'offset'; as?: string | undefined; face?: ModelRefInput | undefined; edges?: ModelRefInput[] | undefined; distance: number }
  | { op: 'fillet_corner'; corner: ModelVec3; radius: number; segments?: number | undefined }
  | { op: 'mirror'; as?: string | undefined; refs: ModelRefInput[]; origin: ModelVec3; normal: ModelVec3; copy?: boolean | undefined }
  | { op: 'intersect_faces'; refs: ModelRefInput[]; with?: ModelRefInput[] | undefined }
  | { op: 'soften_edges'; refs: ModelRefInput[]; angleDeg?: number | undefined; smooth?: boolean | undefined }
  | { op: 'add_guide'; as?: string | undefined; point: ModelVec3; direction?: ModelVec3 | undefined; end?: ModelVec3 | undefined }
  | { op: 'add_dimension'; as?: string | undefined; start: ModelVec3; end: ModelVec3; offset: ModelVec3 }
  | { op: 'add_text'; as?: string | undefined; text: string; anchor?: ModelVec3 | undefined; label?: ModelVec3 | undefined; screen?: [number, number] | undefined }
  | { op: 'add_3d_text'; as?: string | undefined; text: string; position: ModelVec3; height?: number | undefined; extrude?: number | undefined;
    font?: 'sans' | 'serif' | 'mono' | undefined; bold?: boolean | undefined; align?: 'left' | 'center' | 'right' | undefined }
  | { op: 'add_section_plane'; as?: string | undefined; point: ModelVec3; normal: ModelVec3; name?: string | undefined; active?: boolean | undefined }
  | { op: 'set_section_plane'; plane: number | string; active?: boolean | undefined; hidden?: boolean | undefined; reverse?: boolean | undefined }
  | { op: 'set_material'; materialId: number | string; name?: string | undefined; color?: string | undefined; opacity?: number | undefined }
  | { op: 'set_texture'; refs: ModelRefInput[]; grain: ModelVec3 | null }
  | { op: 'make_group'; as?: string | undefined; refs: ModelRefInput[] }
  | { op: 'make_component'; as?: string | undefined; refs: ModelRefInput[]; name?: string | undefined }
  | { op: 'explode'; refs: ModelRefInput[] }
  | { op: 'make_unique'; refs: ModelRefInput[] }
  | { op: 'place_component'; as?: string | undefined; definitionId: number | string; position: ModelVec3 }
  | { op: 'move'; as?: string | undefined; refs: ModelRefInput[]; offset: ModelVec3; copy?: boolean | undefined; copies?: number | undefined }
  | { op: 'rotate'; as?: string | undefined; refs: ModelRefInput[]; origin: ModelVec3; axis: ModelVec3; angleDeg: number; copy?: boolean | undefined; copies?: number | undefined }
  | { op: 'scale'; as?: string | undefined; refs: ModelRefInput[]; origin: ModelVec3; factors: ModelVec3; copy?: boolean | undefined }
  | { op: 'rename_instance'; ref: ModelRefInput; name: string }
  | { op: 'rename_definition'; definitionId: number | string; name: string }
  | { op: 'set_hidden'; refs: ModelRefInput[]; hidden: boolean }
  | { op: 'set_locked'; refs: ModelRefInput[]; locked: boolean }
  | { op: 'delete'; refs: ModelRefInput[] }
  | { op: 'add_tag'; as?: string | undefined; name?: string | undefined; color?: string | undefined }
  | { op: 'assign_tag'; refs: ModelRefInput[]; tagId: number | string }
  | { op: 'set_tag'; tagId: number | string; visible?: boolean | undefined; color?: string | undefined; name?: string | undefined }
  | { op: 'add_material'; as?: string | undefined; name?: string | undefined; color?: string | undefined; opacity?: number | undefined; library?: string | undefined }
  | { op: 'paint'; refs: ModelRefInput[]; materialId: number | string | null; side?: 'front' | 'back' | undefined }
  | { op: 'add_scene'; as?: string | undefined; name?: string | undefined; description?: string | undefined; saves?: ModelSceneSavesInput | undefined;
    includeInAnimation?: boolean | undefined; camera?: ModelCameraInput | undefined }
  | { op: 'update_scene'; scene: ModelSceneRef; camera?: ModelCameraInput | undefined; saves?: ModelSceneSavesInput | undefined; recapture?: boolean | undefined }
  | { op: 'delete_scene'; scene: ModelSceneRef }
  | { op: 'rename_scene'; scene: ModelSceneRef; name?: string | undefined; description?: string | undefined }
  | { op: 'move_scene'; scene: ModelSceneRef; index: number }
  | { op: 'set_scene_animation'; scene: ModelSceneRef; include: boolean };
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
export interface ModelSkipped { ref: ModelRef; reason: 'no_texture' | 'no_grain' | 'end_grain' | 'inside_edge' }
/** What an `as` name of an earlier batch names: its kind and id, and a group's or placement's definition. */
export interface ModelNameEntry { kind: string; id: number; definitionId?: number }

export interface ModelBatchResult {
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
  results: { op: ModelOperationName; id?: number; definitionId?: number; refs?: ModelRef[]; deleted?: ModelRef[]; count?: number; name?: string; skipped?: ModelSkipped[] }[];
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
