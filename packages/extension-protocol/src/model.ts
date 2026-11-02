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
  'set_texture', 'add_guide', 'add_text', 'add_dimension', 'add_section_plane', 'soften_edges',
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
  z.object({
    body: idOrName.describe('The solid: its id, or "$name" of a solid made earlier in the batch.'),
    facing: direction.describe('The face\'s outward direction, within 1 degree: [0, 0, 1] is the top, [0, -1, 0] the front.'),
    point: point.optional().describe('A point on the face, when several faces of the solid face the same way. It also picks one part of a face that shapes drawn on it divide.'),
  }).describe('A face of a solid, chosen without its face id. It must match exactly one face.'),
]).meta({ id: 'ModelRef', description: 'An entity of the container being edited: {kind, id} from model_query, a face {kind: "face", id: bodyId, faceId}, a face chosen as {body, facing, point?}, or "$name" of something made earlier in the batch.' });
export type ModelRefInput = z.infer<typeof modelRefSchema>;
const refs = z.array(modelRefSchema).min(1).max(1000);
const vector = z.tuple([meters, meters, meters]);
const pointList = z.array(point).max(MODEL_LIMITS.pointsPerBatch);
const shapeNormal = direction.describe('The direction the shape faces; push_pull of the shape moves along it. [0, 0, 1] for a shape lying flat.');
const copies = z.number().int().min(1).max(MODEL_LIMITS.copiesPerArray)
  .describe('Leave the originals and make this many copies, each offset from the previous one by the same transform (a linear or polar array).');

export const MODEL_STANDARD_VIEWS = ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'] as const;
const worldPoint = z.tuple([meters, meters, meters]).describe('[x, y, z] in meters in model coordinates, not local to an open group; z is up.');
const projection = z.enum(['perspective', 'parallel']);
const fovDeg = z.number().min(1).max(120).describe('Vertical field of view in degrees, perspective only.');

/**
 * A camera: exact, or framed around a subject from a view direction as Zoom Extents and Zoom Selection frame it. A
 * framed camera fits the subject in the viewport's current proportions and keeps the current projection unless one is
 * given.
 */
export const modelCameraSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('exact'), eye: worldPoint, target: worldPoint, up: direction.optional().describe('Default [0, 0, 1].'),
    projection: projection.optional(), fovDeg: fovDeg.optional(), viewHeight: z.number().positive().optional().describe('Height in meters the view shows at the target, parallel only.') }),
  z.object({ mode: z.literal('framed'),
    direction: z.enum([...MODEL_STANDARD_VIEWS, 'current']).optional().describe('Look from this standard view, or keep the current direction (default). Top looks down; front looks along +y; iso looks down from the front right.'),
    orbitDeg: z.object({
      horizontal: z.number().finite().optional().describe('Turn the direction about the vertical, counterclockwise seen from above.'),
      vertical: z.number().finite().optional().describe('Raise (positive) or lower the eye; the view stays short of straight down or up.'),
    }).optional().describe('Orbit the direction after choosing it.'),
    subject: z.union([z.enum(['model', 'selection', 'target']), z.object({ refs })]).optional()
      .describe('What to fit: the whole model (default), the selection, entities of the container (as model_query names them), or "target" to keep the current target and distance.'),
    margin: z.number().min(0).max(1).optional().describe('Extra space around the subject as a fraction of its size; default 0.05.'),
    projection: projection.optional(), fovDeg: fovDeg.optional() }),
]);
export type ModelCameraInput = z.infer<typeof modelCameraSchema>;

const sceneRef = z.union([id, z.string().trim().min(1).max(200)])
  .describe('A scene id, its name (any letter case), "active" for the active scene, or "$name" of a scene added earlier in the batch.');
const sceneSaves = z.object({
  camera: z.boolean().optional(), hiddenGeometry: z.boolean().optional(), hiddenObjects: z.boolean().optional(), tags: z.boolean().optional(),
  style: z.boolean().optional(), shadows: z.boolean().optional(), sectionPlanes: z.boolean().optional(), axes: z.boolean().optional(),
}).describe('Which properties the scene saves and restores (tags: tag visibility; style: style and fog). Omitted ones keep their setting; a new scene saves all of them.');

export const modelOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_edges'), as: localName.optional(),
    edges: z.array(z.tuple([point, point])).min(1).max(MODEL_LIMITS.pointsPerBatch / 2).describe('Line segments, each [start, end].') })
    .describe('Draw loose line segments. Segments that close a flat loop make a face; segments lying on a face of a solid are drawn on it and divide it. Returns the new edges and faces; "$name" then means them.'),
  z.object({ op: z.literal('add_polyline'), as: localName.optional(), points: pointList.min(2),
    closed: z.boolean().optional().describe('Join the last point back to the first. A closed polyline must be flat and makes a face, such as a profile to push_pull; it faces the way the right-hand rule gives around the points.') })
    .describe('Draw connected edges through the points. Returns the new edges and faces; "$name" then means the shape, so push_pull can pull its face.'),
  z.object({ op: z.literal('add_rectangle'), as: localName.optional(), corner: point,
    side1: vector.describe('[dx, dy, dz] from corner along the first side; its length is that side\'s length.'),
    side2: vector.describe('[dx, dy, dz] from corner along the second side, square to side1.') })
    .describe('Draw a rectangle in any plane, making a face that faces side1 × side2 (side1 [1, 0, 0] and side2 [0, 1, 0] face up). Drawn on a face of a solid, it divides that face instead. Returns its edges and face.'),
  z.object({ op: z.literal('add_circle'), as: localName.optional(), center: point, normal: shapeNormal,
    radius: z.number().positive().finite(), segments: z.number().int().min(3).max(360).optional().describe('Straight edges around the circle; default 24.') })
    .describe('Draw a circle, making a face; pushed or pulled, it makes a smooth round side. Drawn on a face of a solid, it divides that face instead (push_pull it to bore a hole or raise a boss).'),
  z.object({ op: z.literal('add_polygon'), as: localName.optional(), center: point, normal: shapeNormal,
    radius: z.number().positive().finite().describe('From the center to each corner.'), sides: z.number().int().min(3).max(100) })
    .describe('Draw a regular polygon, making a face. The first corner is toward +x from the center for a flat polygon, otherwise level with the center.'),
  z.object({ op: z.literal('push_pull'), as: localName.optional(),
    face: modelRefSchema.describe('"$name" of a closed shape drawn earlier in the batch, a sketchFace, or a face of a solid ({kind: "face"} or {body, facing}).'),
    distance: meters.describe('Meters along the way the face faces: for a drawn shape, its normal; for a face of a solid, outward, so positive adds material and negative cuts in.'),
    mode: z.enum(['merged', 'new_body']).optional().describe('Face of a solid only: merged (default) changes that solid; new_body makes the pulled part a separate solid.') })
    .describe('Push or pull a face. A loose face becomes a new solid, using up the face and its edges. A face of a solid, or a shape drawn on it, changes that solid: pull to add, push in to cut a pocket or a hole through. Returns the solid; as names it.'),
  z.object({ op: z.literal('union'), as: localName.optional(), refs: z.array(modelRefSchema).min(2).max(100).describe('Solids that touch or overlap; the first one survives.') })
    .describe('Join solids into one. Solids that do not touch cannot join: group them instead.'),
  z.object({ op: z.literal('subtract'), as: localName.optional(), target: modelRefSchema.describe('The solid to cut.'),
    cutters: z.array(modelRefSchema).min(1).max(100).describe('Solids whose volume is removed from target, such as boxes placed where a groove, dado, rabbet, cutout or hole goes. Each must overlap the target.'),
    keepCutters: z.boolean().optional().describe('Keep the cutters (default false: they are deleted).') })
    .describe('Cut solids out of a solid. Returns the cut solid; if the cut leaves several pieces, refs lists them all.'),
  z.object({ op: z.literal('intersect'), as: localName.optional(), refs: z.array(modelRefSchema).min(2).max(100).describe('Overlapping solids; the first one survives.') })
    .describe('Keep only the volume all the solids share; the others are deleted.'),
  z.object({ op: z.literal('split'), refs: z.array(modelRefSchema).length(2).describe('Two overlapping solids.') })
    .describe('Replace two overlapping solids by the pieces they make: their shared volume and what is left of each. Returns every piece.'),
  z.object({ op: z.literal('follow_me'), as: localName.optional(),
    profile: modelRefSchema.describe('The face to sweep: "$name" of a closed shape, a sketchFace, or a face of a solid (the sweep then joins that solid).'),
    pathEdges: refs.optional().describe('Loose edges forming one continuous chain, or "$name" of a polyline drawn earlier.'),
    pathPoints: pointList.min(2).optional().describe('The path as points instead of edges; nothing is drawn for it.'),
    closed: z.boolean().optional().describe('Loop the path back to its start. Default: closed when the edges form a loop.') })
    .refine(o => (o.pathEdges === undefined) !== (o.pathPoints === undefined), 'Give either pathEdges or pathPoints.')
    .describe('Sweep a profile face along a path, starting at the end nearest the profile, to make a solid such as a moulding, a rail or a turned part. Draw the profile square to the path where they meet.'),
  z.object({ op: z.literal('add_box'), as: localName.optional(), min: point.describe('One corner: the smallest x, y and z.'), max: point.describe('The opposite corner: the largest x, y and z.') })
    .describe('Add a rectangular solid with its sides along the container\'s axes, between two opposite corners; each side must be longer than zero. Returns the solid\'s id. A part such as a cabinet side or a shelf is one box, made into its own group or component.'),
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
  z.object({ op: z.literal('add_scene'), as: localName.optional(), name: name.optional(), description: z.string().max(2000).optional(), saves: sceneSaves.optional(),
    includeInAnimation: z.boolean().optional().describe('Default true.'), camera: modelCameraSchema.optional().describe('Save this camera without moving the view. Default: the current view.') })
    .describe('Add a scene at the end of the scene order and make it the active scene. Scene names are unique. Returns its id.'),
  z.object({ op: z.literal('update_scene'), scene: sceneRef, camera: modelCameraSchema.optional().describe('Save this camera instead of the current view.'),
    saves: sceneSaves.optional(), recapture: z.boolean().optional().describe('Save the current view, or camera, into the scene again (default true); false only changes saves.') })
    .describe('Save the current view into a scene again.'),
  z.object({ op: z.literal('delete_scene'), scene: sceneRef }),
  z.object({ op: z.literal('rename_scene'), scene: sceneRef, name: name.optional(), description: z.string().max(2000).optional() }),
  z.object({ op: z.literal('move_scene'), scene: sceneRef, index: z.number().int().min(0).describe('New position in the scene order, 0 first.') }),
  z.object({ op: z.literal('set_scene_animation'), scene: sceneRef, include: z.boolean() }).describe('Include a scene in the animation, or leave it out.'),
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

/** What the requester sees: camera, scenes and playback. No undo entry. */
export const modelViewSchema = z.object({
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('set_camera'), camera: modelCameraSchema, animate: z.boolean().optional().describe('Move smoothly over the transition time (default true).') }),
    z.object({ type: z.literal('activate_scene'), scene: sceneRef, animate: z.boolean().optional() }),
    z.object({ type: z.literal('next_scene') }),
    z.object({ type: z.literal('previous_scene') }),
    z.object({ type: z.literal('play') }).describe('Play the animation: the scenes included in it, in order, repeating.'),
    z.object({ type: z.literal('stop') }),
  ]),
});
export type ModelViewInput = z.infer<typeof modelViewSchema>;

export type ModelApiErrorCode = 'stale_revision' | 'invalid_reference' | 'invalid_operation' | 'operation_failed' | 'limit_exceeded' | 'unavailable' | 'invalid_geometry' | 'cancelled';
export interface ModelApiError { code: ModelApiErrorCode; message: string; revision: number | null; operationIndex?: number }

export type ModelVec3 = [number, number, number];
export interface ModelCameraSummary { eye: ModelVec3; target: ModelVec3; up: ModelVec3; projection: 'perspective' | 'parallel'; fovDeg: number; viewHeight: number }
export interface ModelSceneSaves { camera: boolean; hiddenGeometry: boolean; hiddenObjects: boolean; tags: boolean; style: boolean; shadows: boolean; sectionPlanes: boolean; axes: boolean }
export interface ModelSceneSummary { id: number; name: string; description: string; index: number; active: boolean; saves: ModelSceneSaves; includeInAnimation: boolean }
export interface ModelViewResult { ok: true; revision: number; camera: ModelCameraSummary; activeScene: { id: number; name: string } | null; playing: boolean }
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
  scenes: ModelSceneSummary[];
  /** The requester's view; null without a viewport. */
  camera: ModelCameraSummary | null;
  /** Whether the animation is playing. */
  playing: boolean;
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
  /**
   * Per operation: `id` is the main result (a new solid, the face a shape made, a group's instance), `refs` what it
   * created or changed, and `deleted` what it removed, such as the cutters of a subtract.
   */
  results: { op: ModelOperationName; id?: number; definitionId?: number; refs?: ModelRef[]; deleted?: ModelRef[]; count?: number; name?: string }[];
}

/** Tool names and descriptions shared by the host and every client that offers them to a model. */
export const MODEL_TOOLS = {
  getDocument: {
    name: 'model_get_document',
    description: 'Read the open 3D model: its revision, display units, the group or component open for editing, the selection, its bounds, and every group and component definition (with placement counts), tag, material and scene (with which is active), the current camera, and whether the animation is playing. Call it before editing.',
  },
  query: {
    name: 'model_query',
    description: 'List entities of one container (the model, or an open group or component): groups and component placements, solids, loose edges and faces, guides, texts and dimensions, with ids, tags, bounds, transforms and materials in meters. Faces of solids are listed only when kinds includes face, filtered by body id, facing direction or a point on the face. Paged: pass offset from the previous result\'s next.',
  },
  applyOperations: {
    name: 'model_apply_operations',
    description: 'Edit the open 3D model in one atomic batch: every operation applies or none does, and the batch is one undo entry labelled with label. Lengths are meters, local to the container being edited; angles are degrees; z is up. Entities are named by {kind, id} from model_query (faces as {kind: "face", id: bodyId, faceId}). Create operations accept as: "name"; later operations refer to the result as "$name". Returns the new revision and the created ids, or an error naming the failed operation; a stale_revision error means the user changed the model, so read it again before retrying. add_box adds a rectangular solid. Drawing operations (add_edges, add_polyline, add_rectangle, add_circle, add_polygon) make loose edges and faces, or divide the face of a solid when drawn on it; push_pull turns a loose face into a solid or pushes and pulls the face of a solid; union, subtract, intersect and split combine overlapping solids of the container; follow_me sweeps a face along a path. Geometry that would not leave a valid solid fails with invalid_geometry and changes nothing. A face of a solid can be named as {body, facing, point?} instead of by id. Scene operations add, update, delete, rename, reorder and include scenes; a framed camera fits a subject from a view direction.',
  },
  view: {
    name: 'model_view',
    description: 'Change what the requester sees, with no undo entry: set the camera (exact, or framed around the model, the selection or entities from a view direction), go to a scene or the next or previous one, or play and stop the animation. Returns the camera, the active scene and whether the animation is playing. Fails with unavailable where there is no viewport.',
  },
} as const;
