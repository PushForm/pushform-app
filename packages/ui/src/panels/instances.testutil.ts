// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { m4identity, meshBox } from '@pushform/core';
import type { DefId, Id } from '@pushform/core';
import { EntityRefSchema, hostOf } from '@pushform/commands';
import type { Command } from '@pushform/commands';
import { bodyFromMesh, createEntityContainer, instanceAt } from '@pushform/model';
import type { AppInstance } from '../bootstrap';
import { toEntityRef } from '../engine/uiCommands';

/**
 * Test-only: add a group/component definition with one instance in the container at `parent`
 * (root by default), optionally holding a unit box so the definition is solid.
 */
export function addInstance(
  app: AppInstance,
  opts: { name?: string; defName?: string; isGroup?: boolean; parent?: readonly Id[]; withBox?: boolean; hidden?: boolean; locked?: boolean } = {},
): Id {
  let id = 0 as Id;
  app.document.doc.transact('add instance', (draft) => {
    const root = draft.definitions.get(draft.rootDefinitionId)!;
    const defId = draft.meta.nextId++ as DefId;
    const def = { ...root, id: defId, name: opts.defName ?? opts.name ?? 'Group#1', isGroup: opts.isGroup ?? true, entities: createEntityContainer() };
    draft.definitions.set(defId, def as never);
    if (opts.withBox) bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: draft.definitions.get(defId)!.entities });
    id = draft.meta.nextId++ as Id;
    const parentDef = opts.parent?.length ? draft.definitions.get(instanceAt(draft as never, opts.parent)!.definitionId)! : root;
    parentDef.entities.instances.set(id, {
      id,
      definitionId: defId,
      transform: m4identity(),
      name: opts.isGroup === false ? (opts.name ?? '') : (opts.name ?? ''),
      materialId: null,
      tagId: draft.defaultTagId,
      hidden: opts.hidden ?? false,
      locked: opts.locked ?? false,
      castShadows: true,
      receiveShadows: true,
      attributes: {},
    } as never);
    parentDef.entities.order.push(id);
  });
  return id;
}

const refs = z.object({ refs: z.array(EntityRefSchema) });

/**
 * Test-only stubs with agent A's command ids/params (`instance.*`, `definition.rename`, `context.*`,
 * `group.make`, `component.make`), registered only when the real ones are absent. They edit the
 * document so the panels re-render, and push a line per call to `log`.
 */
export function stubInstanceCommands(app: AppInstance, log: string[]): void {
  const reg = app.commands;
  // stubs replace the real commands so tests can assert on the calls
  const add = <P,>(c: Command<P>): void => {
    reg.replace(c);
  };
  const editInstances = (label: string, p: { refs: z.infer<typeof refs>['refs'] }, fn: (inst: { hidden: boolean; locked: boolean }) => void) =>
    hostOf(reg.ctx).edit(label, (draft) => {
      for (const r of p.refs.map(toEntityRef)) {
        const inst = instanceAt(draft as never, [...r.path, r.id]);
        if (inst) fn(inst);
      }
    });
  add({
    id: 'instance.setHidden',
    title: 'Hide',
    category: 'edit',
    params: refs.extend({ hidden: z.boolean() }),
    undoable: true,
    run: (_c, p) => {
      log.push(`setHidden ${p.hidden}`);
      editInstances('Hide', p, (i) => (i.hidden = p.hidden));
    },
  });
  add({
    id: 'instance.setLocked',
    title: 'Lock',
    category: 'edit',
    params: refs.extend({ locked: z.boolean() }),
    undoable: true,
    run: (_c, p) => {
      log.push(`setLocked ${p.locked}`);
      editInstances('Lock', p, (i) => (i.locked = p.locked));
    },
  });
  add({
    id: 'instance.rename',
    title: 'Rename',
    category: 'edit',
    params: z.object({ ref: EntityRefSchema, name: z.string() }),
    undoable: true,
    run: (c, p) => {
      log.push(`rename ${p.name}`);
      const r = toEntityRef(p.ref);
      hostOf(c).edit('Rename', (draft) => {
        const inst = instanceAt(draft as never, [...r.path, r.id]);
        if (inst) inst.name = p.name;
      });
    },
  });
  add({
    id: 'definition.rename',
    title: 'Rename Definition',
    category: 'edit',
    params: z.object({ definitionId: z.number().int(), name: z.string() }),
    undoable: true,
    run: (c, p) => {
      log.push(`definition.rename ${p.name}`);
      hostOf(c).edit('Rename Definition', (draft) => {
        const def = draft.definitions.get(p.definitionId as DefId);
        if (def) def.name = p.name;
      });
    },
  });
  add({
    id: 'context.enter',
    title: 'Edit Group',
    category: 'edit',
    params: z.object({ path: z.array(z.number().int()) }),
    undoable: false,
    run: (c, p) => {
      log.push(`enter ${p.path.join('.')}`);
      hostOf(c).setContext(p.path as Id[]);
    },
  });
  add({
    id: 'context.exit',
    title: 'Close Group',
    category: 'edit',
    params: z.object({}),
    undoable: false,
    when: (c) => hostOf(c).context.path.length > 0,
    run: (c) => {
      log.push('exit');
      hostOf(c).setContext(hostOf(c).context.path.slice(0, -1));
    },
  });
  add({
    id: 'group.make',
    title: 'Make Group',
    category: 'edit',
    params: z.object({ refs: z.array(EntityRefSchema).optional() }),
    undoable: true,
    run: (_c, p) => log.push(`group.make ${p.refs?.length ?? 'selection'}`),
  });
  add({
    id: 'component.make',
    title: 'Make Component',
    category: 'edit',
    params: z.object({
      refs: z.array(EntityRefSchema).optional(),
      name: z.string(),
      description: z.string().optional(),
      glueTo: z.enum(['none', 'any', 'horizontal', 'vertical', 'sloped']).optional(),
      cutOpening: z.boolean().optional(),
      alwaysFaceCamera: z.boolean().optional(),
      shadowsFaceSun: z.boolean().optional(),
      replaceSelection: z.boolean().optional(),
      axesOrigin: z.tuple([z.number(), z.number(), z.number()]).optional(),
      axesX: z.tuple([z.number(), z.number(), z.number()]).optional(),
      axesY: z.tuple([z.number(), z.number(), z.number()]).optional(),
      axesZ: z.tuple([z.number(), z.number(), z.number()]).optional(),
    }),
    undoable: true,
    run: (_c, p) => log.push(`component.make ${JSON.stringify(p)}`),
  });
  add({
    id: 'group.explode',
    title: 'Explode',
    category: 'edit',
    params: z.object({ refs: z.array(EntityRefSchema).optional() }),
    undoable: true,
    run: () => log.push('explode'),
  });
}
