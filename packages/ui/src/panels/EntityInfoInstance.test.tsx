// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { formatVolume } from '../engine/format';
import { EntityInfoPanel } from './EntityInfoPanel';
import { addInstance, stubInstanceCommands } from './instances.testutil';
import { describeSelection } from './entityInfo';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

describe('EntityInfoPanel groups/components', () => {
  it('shares repeated-component counting within a selection read and refreshes after edits and undo', () => {
    const a = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    app = a;
    const first = addInstance(a, { name: 'First', isGroup: false });
    const second = addInstance(a, { name: 'Second', isGroup: false });
    a.document.doc.transact('share definition', draft => {
      const c = draft.definitions.get(draft.rootDefinitionId)!.entities;
      c.instances.get(second)!.definitionId = c.instances.get(first)!.definitionId;
    });
    const state = a.document.doc.state;
    const root = state.definitions.get(state.rootDefinitionId)!;
    const instances = new Map(root.entities.instances);
    const measuredState = { ...state, definitions: new Map(state.definitions) };
    measuredState.definitions.set(root.id, { ...root, entities: { ...root.entities, instances } });
    const refs = [first, second].map(id => ({ kind: 'instance' as const, path: [], id }));
    const visits = vi.spyOn(instances, 'values');
    try {
      expect(describeSelection(measuredState, refs)).toMatchObject({ kind: 'multi', count: 2 });
      expect(visits).toHaveBeenCalledTimes(1);
    } finally { visits.mockRestore(); }
    expect(describeSelection(state, refs.slice(0, 1))).toMatchObject({ kind: 'instance', count: 2 });
    a.document.edit('remove copy', draft => {
      const c = draft.definitions.get(draft.rootDefinitionId)!.entities;
      c.instances.delete(second); c.order = c.order.filter(id => id !== second);
    });
    expect(describeSelection(a.document.doc.state, refs.slice(0, 1))).toMatchObject({ kind: 'instance', count: 1 });
    a.document.undo();
    expect(describeSelection(a.document.doc.state, refs.slice(0, 1))).toMatchObject({ kind: 'instance', count: 2 });
  });

  it('shows Solid Group / Component headers, names, instance count, volume and live Hidden/Locked', () => {
    const log: string[] = [];
    const a = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    app = a;
    stubInstanceCommands(a, log);
    const group = addInstance(a, { name: 'Box group', isGroup: true, withBox: true });
    const chair = addInstance(a, { name: '', defName: 'Chair', isGroup: false });
    addInstance(a, { name: 'Nested', isGroup: true, parent: [chair] });
    render(
      <AppContext.Provider value={a}>
        <EntityInfoPanel />
      </AppContext.Provider>,
    );

    act(() => a.document.selection.set([{ kind: 'instance', path: [], id: group }]));
    expect(screen.getByText('Solid Group')).toBeTruthy();
    expect(screen.queryByLabelText('Definition name')).toBeNull(); // groups have no definition row
    expect((screen.getByLabelText('Instance name') as HTMLInputElement).value).toBe('Box group');
    expect(screen.getByText('1 in model')).toBeTruthy();
    expect(screen.getByText(formatVolume(1, a.document.doc.state.meta.units))).toBeTruthy();
    const hidden = screen.getByLabelText('Hidden') as HTMLInputElement;
    expect(hidden.disabled).toBe(false);
    fireEvent.click(hidden);
    expect(log).toEqual(['setHidden true']);
    expect((screen.getByLabelText('Hidden') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('Locked'));
    expect(log.at(-1)).toBe('setLocked true');

    act(() => a.document.selection.set([{ kind: 'instance', path: [], id: chair }]));
    expect(screen.getByText('Component')).toBeTruthy(); // nested instance → not solid
    const def = screen.getByLabelText('Definition name') as HTMLInputElement;
    expect(def.value).toBe('Chair');
    fireEvent.change(def, { target: { value: 'Armchair' } });
    fireEvent.keyDown(def, { key: 'Enter' });
    expect(log.at(-1)).toBe('definition.rename Armchair');
    const inst = screen.getByLabelText('Instance name') as HTMLInputElement;
    expect(inst.value).toBe('');
    expect(inst.placeholder).toBe('Armchair');
    fireEvent.change(inst, { target: { value: 'chair 1' } });
    fireEvent.blur(inst);
    expect(log.at(-1)).toBe('rename chair 1');
    expect((screen.getByLabelText('Instance name') as HTMLInputElement).value).toBe('chair 1');

    // nested instance selected from the Outliner (path non-empty) resolves too
    const nestedId = [...a.document.doc.state.definitions.values()].find((d) => d.name === 'Armchair')!.entities.instances.keys().next().value!;
    act(() => a.document.selection.set([{ kind: 'instance', path: [chair], id: nestedId }]));
    expect(screen.getByText('Group')).toBeTruthy();
    expect((screen.getByLabelText('Instance name') as HTMLInputElement).value).toBe('Nested');
  });
});
