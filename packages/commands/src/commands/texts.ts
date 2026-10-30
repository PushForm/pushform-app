// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { Id, Vec3 } from '@pushform/core';
import { PushFormError, v3cross, v3dot, v3normalize, v3sub } from '@pushform/core';
import { allocId } from '@pushform/model';
import type { DocumentState, EntityRef, TextEntity, TextLeader } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand, CommandContext } from '../registry/Command';
import { hostOf } from '../host/services';
import { contextFrame, currentFrame, draftContainerAt } from './context';
import { EntityRefSchema } from './sketch';
import { toEntityRefs } from './transform';

/**
 * Texts: the Text tool's output and the edits of the text context menu. Params are world points;
 * texts are stored in the edit context's coordinates, screen text at fractions of the view.
 */

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const fraction = z.number().finite();

/** What the Text tool gives new text: black Arial 12 pt with a closed arrow. */
export const TEXT_DEFAULTS = { fontFamily: 'Arial', fontSizePt: 12, color: [0, 0, 0] as const, arrow: 'closed' as const };
/** Screen text's text before it is edited. */
export const SCREEN_TEXT_PLACEHOLDER = 'Enter text';

export const TEXT_ARROWS = ['none', 'dot', 'closed', 'open', 'slash'] as const;
export type TextArrow = (typeof TEXT_ARROWS)[number];

export const textAdd = defineCommand({
  id: 'text.add',
  title: 'Text',
  category: 'draw',
  params: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('leader'), anchor: vec3, label: vec3, text: z.string() }),
    z.object({ kind: z.literal('screen'), screen: z.tuple([fraction, fraction]), text: z.string() }),
  ]),
  undoable: true,
  run(ctx, p): EntityRef {
    const host = hostOf(ctx);
    const f = currentFrame(host);
    const ref = host.edit('Text', (draft) => {
      const container = draftContainerAt(draft, f.path);
      const id = allocId<Id>(draft);
      const common = {
        id, text: p.text, fontFamily: TEXT_DEFAULTS.fontFamily, fontSizePt: TEXT_DEFAULTS.fontSizePt, color: [...TEXT_DEFAULTS.color] as [number, number, number],
        tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {},
      };
      const text: TextEntity = p.kind === 'leader'
        ? { ...common, kind: 'leader', position: f.toLocal(p.anchor), offset: f.toLocalDir(v3sub(p.label, p.anchor)), leader: 'pushpin', arrow: TEXT_DEFAULTS.arrow }
        : { ...common, kind: 'screen', position: [p.screen[0], p.screen[1], 0], offset: null, leader: 'none' };
      container.texts.set(id, text);
      container.order.push(id);
      return { kind: 'text', path: [...f.path], id } as EntityRef;
    });
    host.selection.set([ref]);
    return ref;
  },
});

function textAt(state: DocumentState, ref: EntityRef): TextEntity {
  if (ref.kind !== 'text') throw new PushFormError('text.target', 'Select a text');
  const text = draftContainerAt(state as never, ref.path).texts.get(ref.id);
  if (!text) throw new PushFormError('text.missing', 'The text no longer exists');
  return text;
}

/** Edit a text's string; text edited to nothing is erased. */
export const textEdit = defineCommand({
  id: 'text.edit',
  title: 'Edit Text',
  category: 'edit',
  params: z.object({ ref: EntityRefSchema, text: z.string() }),
  undoable: true,
  run(ctx, p): { erased: boolean } {
    const host = hostOf(ctx);
    const ref = toEntityRefs([p.ref])[0]!;
    const current = textAt(host.doc.state, ref);
    const erased = !p.text.trim();
    if (!erased && current.text === p.text) return { erased: false };
    host.edit(erased ? 'Erase' : 'Edit Text', (draft) => {
      const container = draftContainerAt(draft, ref.path);
      if (erased) {
        container.texts.delete(ref.id);
        container.order = container.order.filter((x) => x !== ref.id);
      } else container.texts.get(ref.id)!.text = p.text;
    });
    if (erased) host.selection.remove(ref);
    return { erased };
  },
});

const textRefs = (ctx: CommandContext, refs: z.infer<typeof EntityRefSchema>[] | undefined): EntityRef[] => {
  const list = (refs ? toEntityRefs(refs) : hostOf(ctx).selection.refs).filter((r) => r.kind === 'text');
  if (!list.length) throw new PushFormError('text.target', 'Select a text');
  return list;
};

export const textSetArrow = defineCommand({
  id: 'text.setArrow',
  title: 'Arrow',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema).optional(), arrow: z.enum(TEXT_ARROWS) }),
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    const refs = textRefs(ctx, p.refs);
    host.edit('Arrow', (draft) => {
      for (const r of refs) {
        const t = draftContainerAt(draft, r.path).texts.get(r.id);
        if (t) t.arrow = p.arrow;
      }
    });
    return { count: refs.length };
  },
});

/** The current view's right and up directions (world), from the camera. */
function viewAxes(ctx: CommandContext): { right: Vec3; up: Vec3 } | null {
  const cam = ctx.camera?.getState();
  if (!cam) return null;
  const forward = v3normalize(v3sub(cam.target, cam.eye));
  const right = v3normalize(v3cross(forward, cam.up));
  return { right, up: v3cross(right, forward) };
}

/**
 * Leader text's leader: view based, pushpin or hidden. The label keeps its place on screen in the current
 * view: switching to view based measures the pushpin offset along the view's right and up directions, and switching
 * to pushpin turns the view offset into a fixed offset in the model.
 */
export const textSetLeader = defineCommand({
  id: 'text.setLeader',
  title: 'Leader',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema).optional(), leader: z.enum(['view', 'pushpin', 'none']) }),
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    const refs = textRefs(ctx, p.refs).filter((r) => textAt(host.doc.state, r).kind === 'leader');
    if (!refs.length) throw new PushFormError('text.target', 'Screen text has no leader');
    const axes = viewAxes(ctx);
    const state = host.doc.state;
    host.edit('Leader', (draft) => {
      for (const r of refs) {
        const t = draftContainerAt(draft, r.path).texts.get(r.id);
        if (!t) continue;
        const f = contextFrame(state, r.path);
        if (p.leader === 'view' && !t.viewOffset && t.offset && axes) {
          const world = f.toWorldDir(t.offset);
          t.viewOffset = [v3dot(world, axes.right), v3dot(world, axes.up)];
        } else if (p.leader === 'pushpin' && t.viewOffset && axes) {
          const [x, y] = t.viewOffset;
          t.offset = f.toLocalDir([axes.right[0] * x + axes.up[0] * y, axes.right[1] * x + axes.up[1] * y, axes.right[2] * x + axes.up[2] * y]);
          delete t.viewOffset;
        }
        t.leader = p.leader as TextLeader;
      }
    });
    return { count: refs.length };
  },
});

export const textDelete = defineCommand({
  id: 'text.delete',
  title: 'Erase Texts',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema).min(1) }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const refs = toEntityRefs(p.refs).filter((r) => r.kind === 'text');
    return host.edit('Erase', (draft) => {
      let removed = 0;
      for (const r of refs) {
        const container = draftContainerAt(draft, r.path);
        if (!container.texts.delete(r.id)) continue;
        container.order = container.order.filter((x) => x !== r.id);
        removed++;
      }
      return removed;
    });
  },
});

export const textCommands: readonly AnyCommand[] = [textAdd, textEdit, textSetArrow, textSetLeader, textDelete];
