// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { LOCAL_REFERENCE } from './layout.ts';

/**
 * Model document API, version 1. Lengths are meters in right-handed Z-up coordinates, local to the container a
 * request names (the model, or a group or component opened at an instance path); angles are degrees in fields named
 * `...Deg`. Every create operation returns the new entity's id; `as` names it so later operations of the same batch
 * can refer to it as `"$name"`.
 */
export const MODEL_API_VERSION = 1;

/** Bounds a host applies before any work; requests over them fail with `limit_exceeded`. */
export const MODEL_LIMITS = {
  operationsPerBatch: 200, pointsPerBatch: 10_000, copiesPerArray: 100, entitiesPerQuery: 200, loopPointsPerFace: 64, kernelSeconds: 30,
} as const;

/**
 * Operations of later parts of version 1. A host that does not serve one yet answers `unavailable` instead of
 * rejecting it as unknown, so a client can tell "not yet" from "never".
 */
export const MODEL_PLANNED_OPERATIONS = [
  'add_edges', 'add_polyline', 'add_rectangle', 'add_circle', 'add_polygon', 'add_box', 'push_pull',
  'union', 'subtract', 'intersect', 'split', 'follow_me',
  'set_texture', 'add_scene', 'add_guide', 'add_text', 'add_dimension', 'add_section_plane', 'soften_edges',
  'intersect_faces', 'offset', 'fillet', 'set_attribute',
] as const;

const meters = z.number().finite();
const point = z.tuple([meters, meters, meters]).describe('[x, y, z] in meters, in the coordinates of the batch\'s container; z is up.');
const direction = z.tuple([meters, meters, meters]).refine(v => Math.hypot(...v) > 1e-9, 'A direction must not be zero.').describe('[x, y, z] direction; need not be unit length.');
const localName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/).describe('Names this operation\'s result for later operations of the same batch, which refer to it as "$name".');
const id = z.number().int().nonnegative();
const idOrName = z.union([id, z.string().regex(LOCAL_REFERENCE)]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Hex color such as #8b5a2b.');
const name = z.string().trim().min(1).max(200);
const instancePath = z.array(id).max(64).describe('Instance ids from the model down to the open group or component; [] is the model itself.');

export const MODEL_ENTITY_KINDS = ['instance', 'body', 'face', 'sketchEdge', 'sketchFace', 'guide', 'text', 'dimension'] as const;
export type ModelEntityKind = (typeof MODEL_ENTITY_KINDS)[number];

/**
 * An entity of the batch's container. A face is a face of a body: `id` is the body and `faceId` the face.
 * `"$name"` refers to an instance, body or other entity created earlier in the batch.
 */
export const modelRefSchema = z.union([
  z.string().regex(LOCAL_REFERENCE),
  z.object({ kind: z.enum(['instance', 'body', 'sketchEdge', 'sketchFace', 'guide', 'text', 'dimension']), id }),
  z.object({ kind: z.literal('face'), id: id.describe('The body.'), faceId: id }),
]);
export type ModelRefInput = z.infer<typeof modelRefSchema>;
const refs = z.array(modelRefSchema).min(1).max(1000);
const copies = z.number().int().min(1).max(MODEL_LIMITS.copiesPerArray)
  .describe('Leave the originals and make this many copies, each offset from the previous one by the same transform (a linear or polar array).');

export const modelOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('make_group'), as: localName.optional(), refs })
    .describe('Group loose geometry, solids, groups or components of the container into a new group. Returns the group\'s instance id and definition id.'),
  z.object({ op: z.literal('make_component'), as: localName.optional(), refs, name: name.optional() })
    .describe('Make a component of the entities, replaced by one placement of it. Returns its instance id and definition id.'),
  z.object({ op: z.literal('explode'), refs: refs.describe('Groups or component placements.') })
    .describe('Replace groups or placements by their contents in the container. Returns the ids now in the container.'),
  z.object({ op: z.literal('make_unique'), refs: refs.describe('Component placements.') })
    .describe('Give the placements their own copy of the component definition, so later edits change only them.'),
  z.object({ op: z.literal('place_component'), as: localName.optional(), definitionId: idOrName.describe('A component definition (not a group), or "$name" of a placement made earlier in the batch.'), position: point })
    .describe('Place another instance of a component with its origin at position. Returns its instance id.'),
  z.object({ op: z.literal('move'), refs, offset: point.describe('[dx, dy, dz] in meters.'), copy: z.boolean().optional().describe('Move a copy and leave the originals.'), copies: copies.optional() })
    .describe('Move entities by an offset. Returns the moved entities, or the copies.'),
  z.object({ op: z.literal('rotate'), refs, origin: point, axis: direction.describe('Rotation axis through origin, for example [0, 0, 1] to turn about the vertical.'),
    angleDeg: z.number().finite().describe('Counterclockwise looking down the axis.'), copy: z.boolean().optional(), copies: copies.optional() })
    .describe('Rotate entities about an axis through a point. Returns the rotated entities, or the copies.'),
  z.object({ op: z.literal('scale'), refs, origin: point.describe('The point that stays fixed.'),
    factors: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).refine(f => f.every(x => Math.abs(x) > 1e-9), 'Scale factors must not be zero.').describe('[sx, sy, sz]; negative mirrors.'),
    copy: z.boolean().optional() }).describe('Scale entities about a point along the container\'s axes.'),
  z.object({ op: z.literal('rename_instance'), ref: modelRefSchema, name: z.string().max(200).describe('"" clears the instance name.') }),
  z.object({ op: z.literal('rename_definition'), definitionId: idOrName.describe('A definition, or "$name" of a group or placement made earlier in the batch.'), name })
    .describe('Rename a group\'s or component\'s definition; definition names are unique in the model.'),
  z.object({ op: z.literal('set_hidden'), refs, hidden: z.boolean() }),
  z.object({ op: z.literal('set_locked'), refs: refs.describe('Groups or component placements.'), locked: z.boolean() }),
  z.object({ op: z.literal('delete'), refs }).describe('Delete entities of the container. Deleting a face of a solid is not allowed; delete the solid instead.'),
  z.object({ op: z.literal('add_tag'), as: localName.optional(), name: name.optional(), color: color.optional() })
    .describe('Create a tag. Returns its id; "$name" then works wherever a tag id is accepted.'),
  z.object({ op: z.literal('assign_tag'), refs, tagId: idOrName }),
  z.object({ op: z.literal('set_tag'), tagId: idOrName, visible: z.boolean().optional(), color: color.optional(), name: name.optional() }),
  z.object({ op: z.literal('add_material'), as: localName.optional(), name: name.optional(), color, opacity: z.number().min(0).max(1).optional().describe('1 is opaque; default 1.') })
    .describe('Create a plain-color material. Returns its id; "$name" then works wherever a material id is accepted.'),
  z.object({ op: z.literal('paint'), refs: refs.describe('Faces, solids, sketch faces, groups or placements.'),
    materialId: idOrName.nullable().describe('null restores the default material.'), side: z.enum(['front', 'back']).optional().describe('Faces only; default front.') })
    .describe('Paint faces, or whole solids, groups and placements, with a material.'),
]);
export type ModelOperation = z.infer<typeof modelOperationSchema>;
export type ModelOperationName = ModelOperation['op'];

/** One atomic edit: every operation applies, or none does, as one undo entry. */
export const modelBatchSchema = z.object({
  expectedRevision: z.number().int().nonnegative().describe('The revision returned by the last model_get_document, model_query or model_apply_operations call.'),
  container: instancePath.optional().describe('The group or component to edit, as an instance path. Default: the container open in the editor (editContext.path of model_get_document).'),
  label: z.string().trim().min(1).max(60).describe('Short undo label for the whole batch, such as "Group the shelves".'),
  operations: z.array(z.object({ op: z.string() }).passthrough()).min(1).max(MODEL_LIMITS.operationsPerBatch)
    .describe('Operations, run in order. Each is one of the operation objects listed in the tool description.'),
});
/** The schema a model client offers: the batch with its operation union spelled out. */
export const modelBatchToolSchema = modelBatchSchema.extend({ operations: z.array(modelOperationSchema).min(1).max(MODEL_LIMITS.operationsPerBatch) });
export type ModelBatch = z.infer<typeof modelBatchToolSchema>;

/** Field-selected, bounded read of one container's entities; nullable fields so the schema stays strict. */
export const modelQuerySchema = z.object({
  container: instancePath.nullable().describe('null: the container open in the editor.'),
  kinds: z.array(z.enum(MODEL_ENTITY_KINDS)).nullable().describe('null: every kind except face. Faces are listed only when asked for, per body.'),
  ids: z.array(id).max(MODEL_LIMITS.entitiesPerQuery).nullable().describe('null: all. For faces, the body ids whose faces to list.'),
  facing: direction.nullable().describe('Faces only: keep faces whose outward normal is within 1 degree of this direction.'),
  containing: point.nullable().describe('Faces only: keep faces that contain this point.'),
  fields: z.array(z.enum(['bounds', 'geometry', 'appearance'])).nullable().describe('null: all. bounds: bounding boxes; geometry: transforms, points, normals, areas and volumes; appearance: materials.'),
  offset: z.number().int().min(0).nullable(),
  limit: z.number().int().min(1).max(MODEL_LIMITS.entitiesPerQuery).nullable().describe('null: 50.'),
});
export type ModelQuery = z.infer<typeof modelQuerySchema>;
export const modelGetDocumentSchema = z.object({});

export type ModelApiErrorCode = 'stale_revision' | 'invalid_reference' | 'invalid_operation' | 'operation_failed' | 'limit_exceeded' | 'unavailable' | 'invalid_geometry' | 'cancelled';
export interface ModelApiError { code: ModelApiErrorCode; message: string; revision: number | null; operationIndex?: number }

export type ModelVec3 = [number, number, number];
export interface ModelBounds { min: ModelVec3; max: ModelVec3 }
/** An entity as reads report it: the instance path of its container, its kind and id (and face id for faces). */
export interface ModelRef { path: number[]; kind: ModelEntityKind; id: number; faceId?: number }
export interface ModelDefinitionSummary { id: number; name: string; type: 'group' | 'component'; placements: number; solids: number; faces: number; edges: number; instances: number; bounds: ModelBounds | null }
export interface ModelTagSummary { id: number; name: string; visible: boolean; color: string; active: boolean; untagged: boolean }
export interface ModelMaterialSummary { id: number; name: string; color: string; opacity: number; textured: boolean; isDefault: boolean }
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
  scenes: { name: string; index: number }[];
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
  next: number | null;
}
export interface ModelBatchResult {
  ok: true;
  revision: number;
  label: string;
  /** `as` names and the ids they got. */
  created: Record<string, number>;
  results: { op: ModelOperationName; id?: number; definitionId?: number; refs?: ModelRef[]; count?: number }[];
}

/** Tool names and descriptions shared by the host and every client that offers them to a model. */
export const MODEL_TOOLS = {
  getDocument: {
    name: 'model_get_document',
    description: 'Read the open 3D model: its revision, display units, the group or component open for editing, the selection, its bounds, and every group and component definition (with placement counts), tag, material and scene. Call it before editing.',
  },
  query: {
    name: 'model_query',
    description: 'List entities of one container (the model, or an open group or component): groups and component placements, solids, loose edges and faces, guides, texts and dimensions, with ids, tags, bounds, transforms and materials in meters. Faces of solids are listed only when kinds includes face, filtered by body id, facing direction or a point on the face. Paged: pass offset from the previous result\'s next.',
  },
  applyOperations: {
    name: 'model_apply_operations',
    description: 'Edit the open 3D model in one atomic batch: every operation applies or none does, and the batch is one undo entry labelled with label. Lengths are meters, local to the container being edited; angles are degrees; z is up. Entities are named by {kind, id} from model_query (faces as {kind: "face", id: bodyId, faceId}). Create operations accept as: "name"; later operations refer to the result as "$name". Returns the new revision and the created ids, or an error naming the failed operation; a stale_revision error means the user changed the model, so read it again before retrying. Drawing and push/pull operations are not available yet and fail with unavailable.',
  },
} as const;
