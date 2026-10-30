// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { CurveId, FaceLocalId, Id } from '@pushform/core';
import { MERGE_TOL, PushFormError, v3len, v3normalize, v3sub } from '@pushform/core';
import { allocId, DEFAULT_DIMENSION_STYLE, dimensionStyleOf, resolveDimension, switchDimensionType } from '@pushform/model';
import type { Dimension, DimensionAnchor, DimensionStyle, DocumentState, EntityRef } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand, CommandContext } from '../registry/Command';
import { hostOf } from '../host/services';
import { currentFrame, draftContainerAt } from './context';
import { EntityRefSchema } from './sketch';
import { toEntityRefs } from './transform';

/**
 * Dimensions: the Dimension tool's output. Params are world points and vectors, stored local to the
 * edit context; anchor paths are instance chains below the edit context.
 */

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const id = z.number().int().nonnegative();
const path = z.array(id);
const anchor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sketchVertex'), path, id }),
  z.object({ kind: z.literal('bodyVertex'), path, bodyId: id, faceIds: z.array(id).min(1) }),
]).nullable();

/** Default dimension text size; imported dimensions use it too. */
export const DIMENSION_FONT_PT = DEFAULT_DIMENSION_STYLE.fontSizePt;
const arrowSchema = z.enum(['none', 'slash', 'dot', 'closed', 'open']);
const alignSchema = z.enum(['screen', 'above', 'centered', 'outside']);
const styleSchema = z.object({ fontSizePt: z.number().min(1).max(500).optional(), arrow: arrowSchema.optional(), align: alignSchema.optional() });

export const dimensionAdd = defineCommand({
  id: 'dimension.add',
  title: 'Dimension',
  category: 'draw',
  params: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('linear'), start: vec3, end: vec3, offset: vec3, normal: vec3, anchors: z.tuple([anchor, anchor]).optional() }),
    z.object({
      kind: z.enum(['radial', 'diametric']), start: vec3, end: vec3, offset: vec3, normal: vec3,
      curve: z.object({ path, bodyId: id.nullable(), curveId: id }).optional(),
    }),
  ]),
  undoable: true,
  run(ctx, p): number {
    if (v3len(v3sub(p.end, p.start)) <= MERGE_TOL) throw new PushFormError('dimension.points', 'A dimension needs two distinct points');
    if (v3len(p.normal) <= MERGE_TOL) throw new PushFormError('dimension.normal', 'A dimension needs a plane');
    const host = hostOf(ctx);
    const f = currentFrame(host);
    // New dimensions take the model's dimension settings.
    const style = dimensionStyleOf(host.doc.state);
    return host.edit('Dimension', (draft) => {
      const container = draftContainerAt(draft, f.path);
      const dimensionId = allocId<Id>(draft);
      const dimension: Dimension = {
        id: dimensionId, kind: p.kind, start: f.toLocal(p.start), end: f.toLocal(p.end), offset: f.toLocalDir(p.offset),
        normal: f.toLocalNormal(v3normalize(p.normal)), text: null, fontSizePt: style.fontSizePt, arrow: style.arrow, align: style.align,
        tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {},
        ...(p.kind === 'linear' && p.anchors ? { anchors: p.anchors.map((a) => a && (a.kind === 'sketchVertex'
          ? { kind: a.kind, path: a.path as Id[], id: a.id as Id }
          : { kind: a.kind, path: a.path as Id[], bodyId: a.bodyId as Id, faceIds: a.faceIds as FaceLocalId[] })) as [DimensionAnchor | null, DimensionAnchor | null] } : {}),
        ...(p.kind !== 'linear' && p.curve ? { curve: { path: p.curve.path as Id[], bodyId: p.curve.bodyId as Id | null, curveId: p.curve.curveId as CurveId } } : {}),
      };
      container.dimensions.set(dimensionId, dimension);
      container.order.push(dimensionId);
      return dimensionId as number;
    });
  },
});

/** Delete dimensions of the edit context by id (the Eraser's dimension erase). Returns how many were deleted. */
export const dimensionDelete = defineCommand({
  id: 'dimension.delete',
  title: 'Erase Dimensions',
  category: 'edit',
  params: z.object({ ids: z.array(id).min(1) }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const f = currentFrame(host);
    return host.edit('Erase', (draft) => {
      const container = draftContainerAt(draft, f.path);
      const removed = p.ids.filter((dimensionId) => container.dimensions.delete(dimensionId as Id));
      if (removed.length) container.order = container.order.filter((x) => !removed.includes(x));
      return removed.length;
    });
  },
});

function dimensionAt(state: DocumentState, ref: EntityRef): Dimension {
  if (ref.kind !== 'dimension') throw new PushFormError('dimension.target', 'Select a dimension');
  const dim = draftContainerAt(state as never, ref.path).dimensions.get(ref.id);
  if (!dim) throw new PushFormError('dimension.missing', 'The dimension no longer exists');
  return dim;
}

/**
 * Edit a dimension from Entity Info: its text, where `<>` stands for the measured value and empty text shows
 * the measurement, and whether an arc or circle dimension shows its radius or its diameter. One undoable step.
 */
export const dimensionEdit = defineCommand({
  id: 'dimension.edit',
  title: 'Edit Dimension',
  category: 'edit',
  params: z.object({ ref: EntityRefSchema, text: z.string().max(1000).optional(), type: z.enum(['radial', 'diametric']).optional() }),
  undoable: true,
  run(ctx, p): void {
    const host = hostOf(ctx);
    const ref = toEntityRefs([p.ref])[0]!;
    const current = dimensionAt(host.doc.state, ref);
    if (p.type && current.kind === 'linear') throw new PushFormError('dimension.type', 'Only an arc or circle dimension shows a radius or a diameter');
    const text = p.text === undefined ? current.text : p.text.trim() === '' ? null : p.text;
    if (text === current.text && (!p.type || p.type === current.kind)) return;
    host.edit('Edit Dimension', (draft) => {
      const container = draftContainerAt(draft, ref.path);
      const dim = container.dimensions.get(ref.id)!;
      dim.text = text;
      if (p.type && p.type !== dim.kind) Object.assign(dim, switchDimensionType(dim, resolveDimension(draft as unknown as DocumentState, container, dim), p.type));
    });
  },
});

const dimensionRefs = (ctx: CommandContext, refs: z.infer<typeof EntityRefSchema>[] | undefined): EntityRef[] => {
  const list = (refs ? toEntityRefs(refs) : hostOf(ctx).selection.refs).filter((r) => r.kind === 'dimension');
  if (!list.length) throw new PushFormError('dimension.target', 'Select a dimension');
  return list;
};

/** Give dimensions a text size, endpoints or text alignment: Model Info's Update Selected Dimensions. */
export const dimensionSetStyle = defineCommand({
  id: 'dimension.setStyle',
  title: 'Update Selected Dimensions',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema).optional() }).merge(styleSchema),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const refs = dimensionRefs(ctx, p.refs);
    const style: Partial<DimensionStyle> = p.fontSizePt !== undefined || p.arrow || p.align
      ? { ...(p.fontSizePt !== undefined ? { fontSizePt: p.fontSizePt } : {}), ...(p.arrow ? { arrow: p.arrow } : {}), ...(p.align ? { align: p.align } : {}) }
      : dimensionStyleOf(host.doc.state);
    return host.edit('Update Dimensions', (draft) => {
      let n = 0;
      for (const ref of refs) {
        const dim = draftContainerAt(draft, ref.path).dimensions.get(ref.id);
        if (!dim) continue;
        Object.assign(dim, style);
        n++;
      }
      return n;
    });
  },
});

/** Model Info › Dimensions: the text size, endpoints and text alignment new dimensions get. */
export const modelSetDimensionStyle = defineCommand({
  id: 'model.setDimensionStyle',
  title: 'Dimension Settings',
  category: 'edit',
  params: styleSchema,
  undoable: true,
  run(ctx, p): DimensionStyle {
    const host = hostOf(ctx);
    const next: DimensionStyle = {
      ...dimensionStyleOf(host.doc.state),
      ...(p.fontSizePt !== undefined ? { fontSizePt: p.fontSizePt } : {}), ...(p.arrow ? { arrow: p.arrow } : {}), ...(p.align ? { align: p.align } : {}),
    };
    host.edit('Dimension Settings', (draft) => { draft.meta.dimensions = next; });
    return next;
  },
});

export const dimensionCommands: readonly AnyCommand[] = [dimensionAdd, dimensionDelete, dimensionEdit, dimensionSetStyle, modelSetDimensionStyle];
