// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { m4translation } from '@pushform/core';
import type { DefId, Id, Mat4 } from '@pushform/core';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { allocId, createEntityContainer } from '@pushform/model';
import type { DocumentState } from '@pushform/model';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { ComponentsPanel, inModelComponents } from './ComponentsPanel';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

/** Components Chair (placed twice) and Table (unplaced), and a group, which the panel leaves out. */
function mount(): { a: AppInstance; chair: DefId; table: DefId; placed: Id[] } {
  const a = (app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) }));
  let chair = 0 as DefId, table = 0 as DefId;
  const placed: Id[] = [];
  a.document.edit('fixture', (draft) => {
    const s = draft as unknown as DocumentState;
    const root = s.definitions.get(s.rootDefinitionId)!;
    const define = (name: string, isGroup: boolean): DefId => {
      const id = allocId<DefId>(draft);
      s.definitions.set(id, { ...root, id, name, description: '', isGroup, entities: createEntityContainer(), bounds: null,
        behaviors: { glueTo: 'none', cutsOpening: false, alwaysFaceCamera: false, shadowsFaceSun: false } });
      return id;
    };
    const place = (def: DefId, x: number): void => {
      const id = allocId<Id>(draft);
      const container = s.definitions.get(s.rootDefinitionId)!.entities;
      container.instances.set(id, { id, definitionId: def, transform: m4translation([x, 0, 0]) as unknown as Mat4, name: '', materialId: null,
        tagId: s.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} });
      container.order.push(id);
      placed.push(id);
    };
    chair = define('Chair', false); table = define('Table', false);
    place(chair, 0); place(chair, 2); place(define('Group#1', true), 4);
  });
  render(<AppContext.Provider value={a}><ComponentsPanel /></AppContext.Provider>);
  return { a, chair, table, placed };
}
const state = (a: AppInstance) => a.document.doc.state;

describe('Components panel', () => {
  it('lists the model\'s components by name, not groups, and starts placing the one clicked', () => {
    const { a, chair } = mount();
    const list = screen.getByRole('listbox', { name: 'In Model' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['Chair', 'Table']);
    expect(inModelComponents(state(a)).map((d) => d.name)).toEqual(['Chair', 'Table']);
    fireEvent.click(within(list).getByRole('option', { name: /Chair/ }));
    expect(a.toolManager.activeToolId).toBe('placeComponent');
    expect(screen.getByLabelText('Selected component').textContent).toBe('Chair');
    // A click in the model places it (the tool's click runs component.place) and returns to Select.
    act(() => void a.commands.execute('component.place', { definitionId: chair, point: [5, 5, 0] }));
    expect([...state(a).definitions.get(state(a).rootDefinitionId)!.entities.instances.values()].filter((i) => i.definitionId === chair)).toHaveLength(3);
  });

  it('selects instances, replaces selected ones, deletes unused components and opens properties from the context menu', () => {
    const { a, chair, table, placed } = mount();
    const option = (name: string) => within(screen.getByRole('listbox', { name: 'In Model' })).getByRole('option', { name: new RegExp(name) });
    const menu = (name: string, item: string) => { fireEvent.contextMenu(option(name)); fireEvent.click(screen.getByRole('menuitem', { name: item })); };
    menu('Chair', 'Select Instances');
    expect(a.document.selection.refs.map((r) => r.id)).toEqual(placed.slice(0, 2));
    menu('Table', 'Replace Selected');
    const root = state(a).definitions.get(state(a).rootDefinitionId)!.entities;
    expect(placed.slice(0, 2).map((id) => root.instances.get(id)!.definitionId)).toEqual([table, table]);
    act(() => void a.document.undo());
    menu('Table', 'Delete');
    expect(state(a).definitions.has(table)).toBe(false);
    menu('Chair', 'Delete');
    expect(screen.getByRole('alert').textContent).toMatch(/Chair is placed in the model/);
    expect(state(a).definitions.has(chair)).toBe(true);
    menu('Chair', 'Properties');
    expect(screen.getByRole('tab', { name: 'Edit', selected: true })).toBeTruthy();
  });

  it('edits the name, description and behaviors, refusing a taken name', () => {
    const { a, chair } = mount();
    fireEvent.contextMenu(within(screen.getByRole('listbox', { name: 'In Model' })).getByRole('option', { name: /Chair/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Properties' }));
    const name = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'Table' } });
    fireEvent.blur(name);
    expect(screen.getByRole('alert').textContent).toMatch(/already exists/);
    expect((name as HTMLInputElement).value).toBe('Chair');
    fireEvent.change(name, { target: { value: 'Armchair' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    const description = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(description, { target: { value: 'Oak' } });
    fireEvent.blur(description);
    expect((screen.getByRole('checkbox', { name: 'Cut opening' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Glue to' }), { target: { value: 'vertical' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cut opening' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Always face camera' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Shadows face sun' }));
    expect(state(a).definitions.get(chair)).toMatchObject({ name: 'Armchair', description: 'Oak',
      behaviors: { glueTo: 'vertical', cutsOpening: true, alwaysFaceCamera: true, shadowsFaceSun: true } });
    // Turning Always face camera off turns Shadows face sun off with it.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Always face camera' }));
    expect(state(a).definitions.get(chair)!.behaviors).toMatchObject({ alwaysFaceCamera: false, shadowsFaceSun: false });
  });

  it('counts what the selected component holds', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Statistics' }));
    expect(screen.getByText('Select a component in the Select tab.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Select' }));
    fireEvent.contextMenu(within(screen.getByRole('listbox', { name: 'In Model' })).getByRole('option', { name: /Chair/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Properties' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Statistics' }));
    const table = screen.getByRole('table', { name: 'Component statistics' });
    expect(within(table).getByRole('row', { name: /Solids/ }).textContent).toBe('Solids0');
    expect(within(table).queryByRole('row', { name: /Materials/ })).toBeNull();
  });
});
