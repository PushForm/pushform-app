// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { m4translation } from '@pushform/core';
import type { DefId, Id } from '@pushform/core';
import { createDocument } from './Document';
import { createEntityContainer } from './entities/definition';
import { containerAt, contextInverse, contextMatrix, instanceAt, pathWithin, walkInstances } from './context';
import { m4transformPoint } from '@pushform/core';

describe('context helpers', () => {
  it('walks nested instances with accumulated transforms', () => {
    const doc = createDocument();
    let inner = 0 as Id, outer = 0 as Id;
    doc.transact('setup', (draft) => {
      const defA = draft.meta.nextId++ as DefId, defB = draft.meta.nextId++ as DefId;
      const root = draft.definitions.get(draft.rootDefinitionId)!;
      draft.definitions.set(defA, { ...root, id: defA, name: 'A', entities: createEntityContainer() } as never);
      draft.definitions.set(defB, { ...root, id: defB, name: 'B', entities: createEntityContainer() } as never);
      outer = draft.meta.nextId++ as Id;
      inner = draft.meta.nextId++ as Id;
      root.entities.instances.set(outer, { id: outer, definitionId: defA, transform: m4translation([10, 0, 0]), name: 'a', materialId: null, tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} } as never);
      draft.definitions.get(defA)!.entities.instances.set(inner, { id: inner, definitionId: defB, transform: m4translation([0, 5, 0]), name: 'b', materialId: null, tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} } as never);
    });
    const visits = [...walkInstances(doc.state)];
    expect(visits.map((v) => v.path)).toEqual([[outer], [outer, inner]]);
    expect(m4transformPoint(contextMatrix(doc.state, [outer, inner]), [1, 1, 1])).toEqual([11, 6, 1]);
    expect(m4transformPoint(contextInverse(doc.state, [outer, inner]), [11, 6, 1])).toEqual([1, 1, 1]);
    expect(instanceAt(doc.state, [outer])?.name).toBe('a');
    expect(containerAt(doc.state, [outer, inner]).bodies.size).toBe(0);
    expect(pathWithin([outer, inner], [outer])).toBe(true);
    expect(pathWithin([outer], [outer, inner])).toBe(false);
  });
});
