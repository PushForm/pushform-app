// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { MODEL_ENTITY_KINDS } from './model.ts';
import { modelExtensionBatchSchema } from './metadata.ts';

export const TOOL_LIMITS = { primitives: 512, points: 16_384, fields: 32, choices: 16, options: 100, queuedInputs: 64, acknowledgementMs: 10_000 } as const;
const coordinate = z.number().finite().min(-1e12).max(1e12);
const vec3 = z.tuple([coordinate, coordinate, coordinate]);
const vec2 = z.tuple([coordinate, coordinate]);
const screen = z.tuple([z.number().min(-32).max(32), z.number().min(-32).max(32)]);
const direction = vec3.refine(v => Math.hypot(...v) > 0, 'Direction must not be zero');
const text = z.string().max(500);
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,99}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const path = z.array(z.number().int().nonnegative()).max(64);
const id = z.number().int().nonnegative();
const ref = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['body', 'instance', 'sketchEdge', 'sketchFace', 'guide', 'text', 'dimension', 'sectionPlane']), id, path }),
  z.strictObject({ kind: z.literal('face'), id, path, faceId: id }),
  z.strictObject({ kind: z.literal('edge'), id, path, edgeKey: z.string().regex(/^\d+:\d+:\d+$/).max(100) }),
]);
export type ToolRef = z.infer<typeof ref>;
const plane = z.strictObject({ normal: direction, offset: coordinate });
const axis = z.enum(['x', 'y', 'z']);
const width = z.number().positive().max(16).optional();
export const toolPrimitiveSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('point'), position: vec3, color, shape: z.enum(['square', 'circle', 'diamond', 'cross', 'x']), size: z.number().positive().max(48).optional() }),
  z.strictObject({ kind: z.literal('polyline'), points: z.array(vec3).min(2).max(TOOL_LIMITS.points), color, width, closed: z.boolean().optional(), dashed: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('polygon'), points: z.array(vec3).min(3).max(TOOL_LIMITS.points), holes: z.array(z.array(vec3).min(3).max(TOOL_LIMITS.points)).max(256).optional(), color, opacity: z.number().min(0).max(1).optional() }),
  z.strictObject({ kind: z.literal('label'), position: vec3, text, color: color.optional(), offset: vec2.optional() }),
  z.strictObject({ kind: z.literal('cursorHint'), text, screen: screen.optional() }),
  z.strictObject({ kind: z.literal('screenRect'), a: screen, b: screen, color, dashed: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('screenPolyline'), points: z.array(screen).min(2).max(TOOL_LIMITS.points), color, dashed: z.boolean().optional(), closed: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('circle'), center: vec3, normal: direction, radius: z.number().positive().max(1e12), color, dashed: z.boolean().optional(), ticks: z.number().int().min(0).max(360).optional(), width }),
  z.strictObject({ kind: z.literal('box'), min: vec3, max: vec3, color, dashed: z.boolean().optional(), width }),
]);
export type ToolPrimitive = z.infer<typeof toolPrimitiveSchema>;
export const TOOL_VALUE_KINDS = ['empty', 'length', 'angle', 'slope', 'array', 'absolute', 'relative', 'list', 'segments', 'radius', 'circumscribed'] as const;
export const toolViewSchema = z.strictObject({
  instructor: text, cursor: z.enum(['default', 'crosshair', 'pointer', 'not-allowed', 'move', 'grab', 'grabbing']).default('crosshair'),
  pending: z.boolean().default(false),
  keys: z.array(z.enum(['Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Delete'])).max(8).default([]),
  measurement: z.strictObject({ label: z.string().max(100), value: z.string().max(200).optional(), kinds: z.array(z.enum(TOOL_VALUE_KINDS)).max(11) }).optional(),
  fields: z.array(z.strictObject({ id: key, label: z.string().min(1).max(100), kind: z.enum(['length', 'angle', 'number', 'text']), placement: z.enum(['viewport', 'options']).optional(), value: z.string().max(200), at: vec3.optional(), away: direction.optional(), locked: z.boolean().optional() })).max(TOOL_LIMITS.fields).default([]),
  choices: z.array(z.strictObject({ id: key, label: z.string().min(1).max(100), value: z.string().max(100), options: z.array(z.strictObject({ value: z.string().max(100), label: z.string().min(1).max(200) })).max(TOOL_LIMITS.options) })).max(TOOL_LIMITS.choices).default([]),
  overlay: z.array(toolPrimitiveSchema).max(TOOL_LIMITS.primitives).default([]),
  inference: z.strictObject({ anchor: vec3.optional(), plane: plane.optional(), lockAxis: axis.nullable().optional(), pickOnly: z.boolean().optional(), snapping: z.enum(['all', 'none', 'directional']).optional(),
    kinds: z.array(z.enum(MODEL_ENTITY_KINDS)).max(10).optional(), ignore: z.array(ref).max(200).optional() }).optional(),
}).superRefine((view, ctx) => {
  let points = 0;
  for (const primitive of view.overlay) {
    points += primitive.kind === 'polyline' || primitive.kind === 'screenPolyline' ? primitive.points.length : primitive.kind === 'polygon' ? primitive.points.length + (primitive.holes ?? []).reduce((n, hole) => n + hole.length, 0) : 1;
  }
  if (points > TOOL_LIMITS.points) ctx.addIssue({ code: 'custom', message: 'Tool preview exceeds its total point limit.' });
  for (const primitive of view.overlay) if (primitive.kind === 'box' && primitive.min.some((value, index) => value > primitive.max[index]!)) ctx.addIssue({ code: 'custom', message: 'Tool box minimum must not exceed its maximum.' });
  for (const [name, values] of [['field', view.fields], ['choice', view.choices]] as const) if (new Set(values.map(v => v.id)).size !== values.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${name} id.` });
  for (const choice of view.choices) if (new Set(choice.options.map(v => v.value)).size !== choice.options.length || !choice.options.some(option => option.value === choice.value)) ctx.addIssue({ code: 'custom', message: 'Choice must have distinct values and contain its current value.' });
});
export type ToolView = z.infer<typeof toolViewSchema>;
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const toolAckSchema = z.strictObject({ session: z.string().min(1).max(100), sequence });
export const toolPresentSchema = toolAckSchema.extend({ view: toolViewSchema });
export const toolApplySchema = toolAckSchema.extend({ amendPrevious: z.boolean().optional(), batch: modelExtensionBatchSchema });
export const toolEndSchema = z.strictObject({ session: z.string().min(1).max(100) });
const modifiers = z.strictObject({ shift: z.boolean(), ctrl: z.boolean(), alt: z.boolean(), meta: z.boolean() });
const camera = z.strictObject({ eye: vec3, target: vec3, up: direction, projection: z.enum(['perspective', 'parallel']), fovDeg: z.number().positive().max(179), viewHeight: z.number().positive().max(1e12) });
const snap = z.strictObject({ kind: z.enum(['endpoint', 'midpoint', 'onEdge', 'intersection', 'center', 'onFace', 'onPlane', 'origin', 'guide', 'onAxis', 'fromPoint', 'perpendicular', 'parallel', 'tangent', 'extension', 'free']),
  point: vec3, ref: ref.optional(), direction: direction.optional(), plane: plane.optional() });
const pointer = z.strictObject({ screen, ray: z.strictObject({ origin: vec3, direction }), button: z.number().int().min(-1).max(2), buttons: z.number().int().min(0).max(31), modifiers,
  point: vec3, pickRadius: z.number().finite().nonnegative().max(1e12).optional(), snap, hit: z.strictObject({ ref, point: vec3, normal: direction.optional(), selectable: ref.optional() }).nullable(), camera });
const empty = z.strictObject({});
const entry = z.strictObject({ text: z.string().max(500), defaultUnit: z.enum(['mm', 'cm', 'm', 'in', 'ft', 'yd']) });
/** Input sources are produced only by the trusted, active viewport adapter. */
export const toolSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['activate', 'cancel', 'suspend', 'resume', 'resync']), data: empty }),
  z.strictObject({ kind: z.enum(['pointerMove', 'pointerDown', 'pointerUp', 'click', 'doubleClick']), data: pointer }),
  z.strictObject({ kind: z.enum(['keyDown', 'keyUp']), data: z.strictObject({ key: z.string().max(100), code: z.string().max(100), repeat: z.boolean(), modifiers }) }),
  z.strictObject({ kind: z.literal('wheel'), data: z.strictObject({ screen, deltaY: z.number().finite(), modifiers }) }),
  z.strictObject({ kind: z.literal('measurement'), data: entry }),
  z.strictObject({ kind: z.literal('entry'), data: z.strictObject({ values: z.array(z.strictObject({ id: key, ...entry.shape })).max(TOOL_LIMITS.fields) }) }),
  z.strictObject({ kind: z.literal('entryLock'), data: z.strictObject({ id: key, value: entry.nullable() }) }),
  z.strictObject({ kind: z.literal('choice'), data: z.strictObject({ id: key, value: z.string().max(100) }) }),
]);
export type ToolSource = z.infer<typeof toolSourceSchema>;
export const toolStampSchema = z.strictObject({ revision: sequence, contextVersion: sequence, cameraVersion: sequence, context: path });
export type ToolStamp = z.infer<typeof toolStampSchema>;
export type ToolInput = ToolSource & ToolStamp & { session: string; sequence: number };
export type ToolStopReason = 'ended' | 'cancelled' | 'replaced' | 'disabled' | 'document.closed' | 'runtime.failed' | 'limit.exceeded' | 'unresponsive';
