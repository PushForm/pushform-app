// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { DefId, Id } from '@pushform/core';
import { m4translation, PushFormError } from '@pushform/core';
import { definitionAt } from '@pushform/model';
import type { ComponentBehaviors, DocumentState, EntityRef } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand, CommandContext } from '../registry/Command';
import { hostOf } from '../host/services';
import { currentFrame, draftContainerAt } from './context';
import { instanceCount, newInstance } from './groups';

/** The Components panel's commands: place, select, replace, delete and edit component definitions. */

const idSchema = z.number().int().nonnegative();

/** A component definition (not a group, not the model) or an error naming why not. */
function componentDefinition(state: DocumentState, id: number) {
  const def = state.definitions.get(id as DefId);
  if (!def || def.id === state.rootDefinitionId || def.isGroup) throw new PushFormError('component.missing', `Component ${id} not found`);
  return def;
}

/**
 * Whether placing `definitionId` in the context at `path` would put a component inside itself: the definition is the
 * open context or one around it, or contains one of them.
 */
export function placesInsideItself(state: DocumentState, path: readonly Id[], definitionId: DefId): boolean {
  const enclosing = new Set<DefId>([state.rootDefinitionId, ...path.map((_, i) => definitionAt(state, path.slice(0, i + 1)).id)]);
  const seen = new Set<DefId>();
  const reaches = (id: DefId): boolean => {
    if (enclosing.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const def = state.definitions.get(id);
    return !!def && [...def.entities.instances.values()].some((i) => reaches(i.definitionId));
  };
  return reaches(definitionId);
}

/** Place an instance of a component with its insertion point (the definition's origin) on `point`, in world coordinates. */
export const componentPlace = defineCommand({
  id: 'component.place',
  title: 'Place Component',
  category: 'internal',
  params: z.object({ definitionId: idSchema, point: z.tuple([z.number(), z.number(), z.number()]) }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const path = host.context.path;
    const state = host.doc.state;
    const def = componentDefinition(state, p.definitionId);
    if (placesInsideItself(state, path, def.id)) throw new PushFormError('component.recursive', 'A component cannot be placed inside itself');
    const local = currentFrame(host).toLocal(p.point);
    let id = 0;
    host.edit('Place Component', (draft) => {
      const container = draftContainerAt(draft, path);
      const inst = newInstance(draft, def.id, m4translation(local));
      container.instances.set(inst.id, inst);
      container.order.push(inst.id);
      id = inst.id;
    });
    host.selection.set([{ kind: 'instance', path, id: id as Id }]);
    return id;
  },
});

/** Select the instances of a component in the open context. */
export const componentSelectInstances = defineCommand({
  id: 'component.selectInstances',
  title: 'Select Instances',
  category: 'internal',
  params: z.object({ definitionId: idSchema }),
  undoable: false,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const path = host.context.path;
    const def = componentDefinition(host.doc.state, p.definitionId);
    const container = definitionAt(host.doc.state, path).entities;
    const refs: EntityRef[] = [...container.instances.values()].filter((i) => i.definitionId === def.id).map((i) => ({ kind: 'instance', path, id: i.id }));
    host.selection.set(refs);
    return refs.length;
  },
});

/** Selected component instances of the open context: their definitions change to `definitionId`, keeping their placement. */
export const componentReplaceSelected = defineCommand({
  id: 'component.replaceSelected',
  title: 'Replace Selected',
  category: 'internal',
  params: z.object({ definitionId: idSchema }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const path = host.context.path;
    const state = host.doc.state;
    const def = componentDefinition(state, p.definitionId);
    const container = definitionAt(state, path).entities;
    const targets = host.selection.refs.filter((r) => r.kind === 'instance' && pathEquals(r.path, path)).map((r) => container.instances.get(r.id))
      .filter((i) => i !== undefined && !state.definitions.get(i.definitionId)?.isGroup && i.definitionId !== def.id);
    if (!targets.length) throw new PushFormError('component.replaceTarget', 'Select component instances to replace');
    if (placesInsideItself(state, path, def.id)) throw new PushFormError('component.recursive', 'A component cannot be placed inside itself');
    host.edit('Replace Selected', (draft) => {
      const draftContainer = draftContainerAt(draft, path);
      for (const target of targets) {
        const inst = draftContainer.instances.get(target!.id);
        if (inst) inst.definitionId = def.id;
      }
    });
    return targets.length;
  },
});

/** Delete a component definition that no instance uses. */
export const componentDelete = defineCommand({
  id: 'component.delete',
  title: 'Delete Component',
  category: 'internal',
  params: z.object({ definitionId: idSchema }),
  undoable: true,
  run(ctx, p): void {
    const host = hostOf(ctx);
    const def = componentDefinition(host.doc.state, p.definitionId);
    if (instanceCount(host.doc.state, def.id) > 0) throw new PushFormError('component.inUse', `${def.name} is placed in the model; delete its instances first`);
    host.edit('Delete Component', (draft) => { draft.definitions.delete(def.id); });
  },
});

/** Edit a component's name, description and behaviors. Names stay unique (`definition.nameTaken`). */
export const definitionSetProperties = defineCommand({
  id: 'definition.setProperties',
  title: 'Edit Component',
  category: 'internal',
  params: z.object({
    definitionId: idSchema,
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    glueTo: z.enum(['none', 'any', 'horizontal', 'vertical', 'sloped']).optional(),
    cutsOpening: z.boolean().optional(),
    alwaysFaceCamera: z.boolean().optional(),
    shadowsFaceSun: z.boolean().optional(),
  }),
  undoable: true,
  run(ctx, p): void {
    const host = hostOf(ctx);
    const def = componentDefinition(host.doc.state, p.definitionId);
    if (p.name !== undefined && p.name !== def.name && [...host.doc.state.definitions.values()].some((d) => d.id !== def.id && d.name === p.name)) {
      throw new PushFormError('definition.nameTaken', `A definition named "${p.name}" already exists`);
    }
    host.edit('Edit Component', (draft) => {
      const target = draft.definitions.get(def.id)!;
      if (p.name !== undefined) target.name = p.name;
      if (p.description !== undefined) target.description = p.description;
      const behaviors: Partial<ComponentBehaviors> = {};
      if (p.glueTo !== undefined) behaviors.glueTo = p.glueTo;
      if (p.cutsOpening !== undefined) behaviors.cutsOpening = p.cutsOpening;
      if (p.alwaysFaceCamera !== undefined) behaviors.alwaysFaceCamera = p.alwaysFaceCamera;
      if (p.shadowsFaceSun !== undefined) behaviors.shadowsFaceSun = p.shadowsFaceSun;
      Object.assign(target.behaviors, behaviors);
    });
  },
});

/** The component the Place Component tool attaches to the cursor. */
export interface ComponentPlacementStore { current: DefId | null }
export const componentPlacement: ComponentPlacementStore = { current: null };

/** Start placing a component: it follows the cursor and a click places it. */
export const componentStartPlacing = defineCommand({
  id: 'component.startPlacing',
  title: 'Place Component',
  category: 'internal',
  params: z.object({ definitionId: idSchema }),
  undoable: false,
  run(ctx: CommandContext, p): void {
    const def = componentDefinition(hostOf(ctx).doc.state, p.definitionId);
    componentPlacement.current = def.id;
    ctx.tools?.activate('placeComponent');
  },
});

const pathEquals = (a: readonly Id[], b: readonly Id[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export const componentCommands: readonly AnyCommand[] = [
  componentPlace, componentSelectInstances, componentReplaceSelected, componentDelete, definitionSetProperties, componentStartPlacing,
];
