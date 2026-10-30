// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { Id, MMat4, MVec3, Plane, Vec3 } from '@pushform/core';
import { m4identity, m4invert, m4transformDir, m4transformPoint, planeFromPointNormal, PushFormError, v3normalize } from '@pushform/core';
import { containerAt, contextAt, contextMatrix, definitionAt, pathKey, SketchGraph } from '@pushform/model';
import type { Body, DocumentDraft, DocumentState, Draft, EditContext, EntityContainer, EntityRef } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import type { DocumentHost } from '../host/DocumentHost';
import { hostOf } from '../host/services';

/**
 * Edit context ("Edit Group/Component"): the instance path the user double-clicked into.
 * Tools work in world coordinates (inference returns world points); commands that write geometry
 * convert world → context-local with the helpers below and treat body meshes as context-local.
 */

// ---------------------------------------------------------------------------------------------
// Coordinate frames

/** World ↔ local conversion for one edit context. `identity` is true at the root (no conversion). */
export interface ContextFrame {
  readonly path: readonly Id[];
  /** local → world */
  readonly matrix: MMat4;
  /** world → local */
  readonly inverse: MMat4;
  readonly identity: boolean;
  /** Sign of the linear determinant of `matrix` (negative = mirrored context). */
  readonly mirrored: boolean;
  toLocal(p: Vec3): MVec3;
  toWorld(p: Vec3): MVec3;
  /** Directions (translation ignored). */
  toLocalDir(d: Vec3): MVec3;
  toWorldDir(d: Vec3): MVec3;
  /** Unit plane normals: transformed by the inverse transpose so planes stay planes under scale. */
  toWorldNormal(n: Vec3): MVec3;
  toLocalNormal(n: Vec3): MVec3;
  toLocalPlane(plane: Plane): Plane;
  toWorldPlane(plane: Plane): Plane;
}

const linearDeterminant = (m: ArrayLike<number>): number => {
  const a = m[0]!, b = m[4]!, c = m[8]!;
  const d = m[1]!, e = m[5]!, f = m[9]!;
  const g = m[2]!, h = m[6]!, i = m[10]!;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
};

/** Transpose of the linear part applied to a vector (column-major `m`). */
function m4transformDirTransposed(m: ArrayLike<number>, d: Vec3): MVec3 {
  return [
    m[0]! * d[0] + m[1]! * d[1] + m[2]! * d[2],
    m[4]! * d[0] + m[5]! * d[1] + m[6]! * d[2],
    m[8]! * d[0] + m[9]! * d[1] + m[10]! * d[2],
  ];
}

const IDENTITY_FRAME_CACHE = new Map<string, ContextFrame>();

/** Frame of the context at `path` in `state`. */
export function contextFrame(state: DocumentState, path: readonly Id[]): ContextFrame {
  if (path.length === 0) {
    const cached = IDENTITY_FRAME_CACHE.get('');
    if (cached) return cached;
    const frame = frameFromMatrix([], m4identity());
    IDENTITY_FRAME_CACHE.set('', frame);
    return frame;
  }
  return frameFromMatrix(path, contextMatrix(state, path));
}

export function frameFromMatrix(path: readonly Id[], matrix: MMat4): ContextFrame {
  const inverse = m4invert(matrix);
  if (!inverse) throw new PushFormError('context.singular', `The transform of the context ${pathKey(path)} is singular`);
  const identity = matrix.every((v, i) => v === (i % 5 === 0 ? 1 : 0));
  const id = (p: Vec3): MVec3 => [p[0], p[1], p[2]];
  const toLocal = identity ? id : (p: Vec3): MVec3 => m4transformPoint(inverse, p);
  const toWorld = identity ? id : (p: Vec3): MVec3 => m4transformPoint(matrix, p);
  const toLocalDir = identity ? id : (d: Vec3): MVec3 => m4transformDir(inverse, d);
  const toWorldDir = identity ? id : (d: Vec3): MVec3 => m4transformDir(matrix, d);
  const toWorldNormal = identity ? id : (n: Vec3): MVec3 => v3normalize(m4transformDirTransposed(inverse, n));
  const toLocalNormal = identity ? id : (n: Vec3): MVec3 => v3normalize(m4transformDirTransposed(matrix, n));
  const planeOrigin = (pl: Plane): MVec3 => [-pl.n[0] * pl.d, -pl.n[1] * pl.d, -pl.n[2] * pl.d];
  return {
    path: [...path],
    matrix,
    inverse,
    identity,
    mirrored: linearDeterminant(matrix) < 0,
    toLocal,
    toWorld,
    toLocalDir,
    toWorldDir,
    toWorldNormal,
    toLocalNormal,
    toLocalPlane: identity ? (pl) => pl : (pl) => planeFromPointNormal(toLocal(planeOrigin(pl)), toLocalNormal(pl.n)),
    toWorldPlane: identity ? (pl) => pl : (pl) => planeFromPointNormal(toWorld(planeOrigin(pl)), toWorldNormal(pl.n)),
  };
}

/** Frame of the host's current edit context. */
export function currentFrame(host: DocumentHost): ContextFrame {
  return contextFrame(host.doc.state, host.context.path);
}

// ---------------------------------------------------------------------------------------------
// Containers and ref validation

export const samePath = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);
/** Stable string key of an instance path (empty = root). */
export const pathKeyOf = (path: readonly number[]): string => path.join('.');

/**
 * Throw `context.mismatch` unless `path` is the host's current context path. Commands that write
 * geometry only accept refs of the open context (you can only edit what you are in).
 */
export function requireContextPath(host: DocumentHost, path: readonly number[], what = 'Entity'): readonly Id[] {
  if (!samePath(path, host.context.path)) {
    throw new PushFormError('context.mismatch', `${what} is not in the current edit context (${pathKey(host.context.path) || 'root'})`);
  }
  return host.context.path;
}

/** Container of the context at `path` in a draft (typed as the plain container; it is a draft at runtime). */
export function draftContainerAt(draft: DocumentDraft, path: readonly number[]): EntityContainer {
  return containerAt(draft as unknown as DocumentState, path as readonly Id[]);
}

/** cast: inside a transaction a body is a draft; Body and Draft<Body> differ only in tuple mutability. */
export const asDraftBody = (b: Body): Draft<Body> => b as unknown as Draft<Body>;

/** Body `id` of the container at `path` in a draft, typed as a draft for the imprint helpers. */
export function draftBodyAt(draft: DocumentDraft, path: readonly number[], id: Id): Draft<Body> | undefined {
  const b = draftContainerAt(draft, path).bodies.get(id);
  return b ? asDraftBody(b) : undefined;
}

/** Container of the host's current context (read-only state). */
export function currentContainer(host: DocumentHost): EntityContainer {
  return containerAt(host.doc.state, host.context.path);
}

/** Sketch graph of the context at `path` in a draft. */
export function sketchGraphAt(draft: DocumentDraft, path: readonly number[]): SketchGraph {
  const def = definitionAt(draft as unknown as DocumentState, path as readonly Id[]);
  return SketchGraph.for(draft, def.id);
}

/** Refs of the current context only (selection may hold refs of other contexts after a context change). */
export function refsInContext(host: DocumentHost, refs: readonly EntityRef[]): EntityRef[] {
  return refs.filter((r) => samePath(r.path, host.context.path));
}

// ---------------------------------------------------------------------------------------------
// Validation

/**
 * Validate an instance path: every step must be an instance of the previous container and no
 * step may be locked (`context.locked`). Returns the context.
 */
export function validateContextPath(state: DocumentState, path: readonly number[]): EditContext {
  let container = containerAt(state, []);
  for (const id of path) {
    const inst = container.instances.get(id as Id);
    if (!inst) throw new PushFormError('context.invalid', `No instance ${id} on path ${pathKey(path as readonly Id[])}`);
    if (inst.locked) throw new PushFormError('context.locked', `Instance ${id} is locked and cannot be edited`);
    const def = state.definitions.get(inst.definitionId);
    if (!def) throw new PushFormError('context.invalid', `Instance ${id} has no definition`);
    container = def.entities;
  }
  return contextAt(state, path as readonly Id[]);
}

// ---------------------------------------------------------------------------------------------
// Commands (not undoable: the context is runtime state; the host emits `contextChanged`)

const pathSchema = z.array(z.number().int().nonnegative());
const idSchema = z.number().int().nonnegative();

export interface ContextInfo {
  readonly path: number[];
  readonly definitionId: number;
  /** local → world matrix of the context (column-major). */
  readonly matrix: number[];
}

function contextInfo(host: DocumentHost): ContextInfo {
  const ctx = host.context;
  return { path: [...ctx.path], definitionId: ctx.definitionId, matrix: contextMatrix(host.doc.state, ctx.path) };
}

/**
 * Enter the context at `path` (instance ids from the root), or `instanceId` of the current
 * context (double-click on a group/component). Locked instances cannot be entered.
 */
export const contextEnter = defineCommand({
  id: 'context.enter',
  title: 'Edit Group/Component',
  category: 'edit',
  params: z.object({ path: pathSchema.optional(), instanceId: idSchema.optional() }),
  undoable: false,
  run(ctx, p): ContextInfo {
    const host = hostOf(ctx);
    const path = p.path ?? (p.instanceId !== undefined ? [...host.context.path, p.instanceId] : null);
    if (!path) throw new PushFormError('command.params', 'context.enter needs a path or an instanceId');
    validateContextPath(host.doc.state, path);
    host.setContext(path as Id[]);
    return contextInfo(host);
  },
});

/** Close the current group/component (one level up). No-op at the root. */
export const contextExit = defineCommand({
  id: 'context.exit',
  title: 'Close Group/Component',
  category: 'edit',
  params: z.object({}),
  undoable: false,
  run(ctx): ContextInfo {
    const host = hostOf(ctx);
    if (host.context.path.length) host.setContext(host.context.path.slice(0, -1));
    return contextInfo(host);
  },
});

/** Back to the root context. */
export const contextExitAll = defineCommand({
  id: 'context.exitAll',
  title: 'Close All Groups/Components',
  category: 'edit',
  params: z.object({}),
  undoable: false,
  run(ctx): ContextInfo {
    const host = hostOf(ctx);
    host.setContext([]);
    return contextInfo(host);
  },
});

export const contextGet = defineCommand({
  id: 'context.get',
  title: 'Edit Context',
  category: 'internal',
  params: z.object({}),
  undoable: false,
  run: (ctx): ContextInfo => contextInfo(hostOf(ctx)),
});

export const contextCommands: readonly AnyCommand[] = [contextEnter, contextExit, contextExitAll, contextGet];
