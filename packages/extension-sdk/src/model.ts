// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors

/**
 * The model document API as `context.model` and `context.selection` use it, version 1. Lengths are meters in
 * right-handed Z-up coordinates, local to the container a request names (the model, or a group or component opened at
 * an instance path); angles are degrees in fields named `...Deg`. Reads are bounded: a query returns at most 200
 * entities per page, and a batch holds at most 200 operations.
 */

export type ModelVec3 = [number, number, number];
export type ModelEntityKind = 'instance' | 'body' | 'face' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension';

/**
 * An entity of the container being edited, as requests name it. A face is a face of a body: `id` is the body and
 * `faceId` the face. `"$name"` refers to an entity created earlier in the same batch. The refs reads return
 * (`ModelRef`) are accepted too; their `path` is ignored.
 */
export type ModelRefInput = string
  | { kind: 'instance' | 'body' | 'sketchEdge' | 'sketchFace' | 'guide' | 'text' | 'dimension'; id: number }
  | { kind: 'face'; id: number; faceId: number };

/** An entity as reads report it: the instance path of its container, its kind and id (and face id for faces). */
export interface ModelRef { path: number[]; kind: ModelEntityKind; id: number; faceId?: number }

export interface ModelBounds { min: ModelVec3; max: ModelVec3 }
export interface ModelCameraSummary { eye: ModelVec3; target: ModelVec3; up: ModelVec3; projection: 'perspective' | 'parallel'; fovDeg: number; viewHeight: number }
export interface ModelSceneSaves { camera: boolean; hiddenGeometry: boolean; hiddenObjects: boolean; tags: boolean; style: boolean; shadows: boolean; sectionPlanes: boolean; axes: boolean }
export interface ModelSceneSummary { id: number; name: string; description: string; index: number; active: boolean; saves: ModelSceneSaves; includeInAnimation: boolean }
export interface ModelDefinitionSummary { id: number; name: string; type: 'group' | 'component'; placements: number; solids: number; faces: number; edges: number; instances: number; bounds: ModelBounds | null }
export interface ModelTagSummary { id: number; name: string; visible: boolean; color: string; active: boolean; untagged: boolean }
export interface ModelMaterialSummary { id: number; name: string; color: string; opacity: number; textured: boolean; isDefault: boolean }

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
  /** null: every kind except face. Faces are listed only when asked for, per body. */
  kinds: ModelEntityKind[] | null;
  /** null: all. For faces, the body ids whose faces to list. At most 200. */
  ids: number[] | null;
  /** Faces only: keep faces whose outward normal is within 1 degree of this direction. */
  facing: ModelVec3 | null;
  /** Faces only: keep faces that contain this point. */
  containing: ModelVec3 | null;
  /** null: all. bounds: bounding boxes; geometry: transforms, points, normals, areas and volumes; appearance: materials. */
  fields: ('bounds' | 'geometry' | 'appearance')[] | null;
  offset: number | null;
  /** 1 to 200; null: 50. */
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
  /** Solids. */
  volume?: number;
  area?: number;
  faceCount?: number;
  /** Faces. */
  normal?: ModelVec3;
  outerLoop?: ModelVec3[];
  loopPointCount?: number;
  holes?: number;
  /** Sketch edges. */
  start?: ModelVec3;
  end?: ModelVec3;
  soft?: boolean;
  smooth?: boolean;
  curve?: boolean;
  /** Guides, texts and dimensions. */
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

/** One operation of a batch. Create operations accept `as`; later operations refer to the result as `"$name"`. */
export type ModelOperation =
  | { op: 'make_group'; as?: string | undefined; refs: ModelRefInput[] }
  | { op: 'make_component'; as?: string | undefined; refs: ModelRefInput[]; name?: string | undefined }
  | { op: 'explode'; refs: ModelRefInput[] }
  | { op: 'make_unique'; refs: ModelRefInput[] }
  | { op: 'place_component'; as?: string | undefined; definitionId: number | string; position: ModelVec3 }
  | { op: 'move'; refs: ModelRefInput[]; offset: ModelVec3; copy?: boolean | undefined; copies?: number | undefined }
  | { op: 'rotate'; refs: ModelRefInput[]; origin: ModelVec3; axis: ModelVec3; angleDeg: number; copy?: boolean | undefined; copies?: number | undefined }
  | { op: 'scale'; refs: ModelRefInput[]; origin: ModelVec3; factors: ModelVec3; copy?: boolean | undefined }
  | { op: 'rename_instance'; ref: ModelRefInput; name: string }
  | { op: 'rename_definition'; definitionId: number | string; name: string }
  | { op: 'set_hidden'; refs: ModelRefInput[]; hidden: boolean }
  | { op: 'set_locked'; refs: ModelRefInput[]; locked: boolean }
  | { op: 'delete'; refs: ModelRefInput[] }
  | { op: 'add_tag'; as?: string | undefined; name?: string | undefined; color?: string | undefined }
  | { op: 'assign_tag'; refs: ModelRefInput[]; tagId: number | string }
  | { op: 'set_tag'; tagId: number | string; visible?: boolean | undefined; color?: string | undefined; name?: string | undefined }
  | { op: 'add_material'; as?: string | undefined; name?: string | undefined; color: string; opacity?: number | undefined }
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

export interface ModelBatchResult {
  ok: true;
  revision: number;
  label: string;
  /** `as` names and the ids they got. */
  created: Record<string, number>;
  results: { op: ModelOperationName; id?: number; definitionId?: number; refs?: ModelRef[]; count?: number; name?: string }[];
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

/** Told when a document the extension subscribed to changes. */
export interface ModelChangeEvent {
  document: string;
  revision: number;
  /** The model itself, or the selection (only with `selection.read`). */
  changes: ('model' | 'selection')[];
}
