// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocumentState, type LayoutDocumentState, type LayoutEntity, type LayoutPage } from './LayoutDocument';
import { LAYOUT_OBJECT_NAME_MAX, layoutDefaultObjectNames, layoutObjectKind, layoutObjectName } from './objectNames';

const path = (id: number, points: [number, number][], extra: Partial<LayoutEntity> = {}): LayoutEntity =>
  ({ id, kind: 'path', layerId: 1, points, closed: false, ...extra });
const of = (id: number, kind: LayoutEntity['kind']): LayoutEntity => ({ id, kind, layerId: 1, points: [[0, 0], [1, 1]], closed: false });

function stateWith(pageEntities: LayoutEntity[][], shared: LayoutEntity[] = []): LayoutDocumentState {
  const state = createLayoutDocumentState(), first = state.pages.get(state.pageOrder[0]!)!;
  pageEntities.forEach((entities, index) => {
    const page: LayoutPage = index === 0 ? first : { ...first, id: 100 + index, name: `Page ${index + 1}`, entities: new Map(), entityOrder: [] };
    for (const entity of entities) { page.entities.set(entity.id, entity); page.entityOrder.push(entity.id); }
    if (index) { state.pages.set(page.id, page); state.pageOrder.push(page.id); }
  });
  for (const entity of shared) { state.sharedEntities.set(entity.id, entity); state.sharedEntityOrder.push(entity.id); }
  return state;
}

describe('Layout object names', () => {
  it('classifies straight two-point open paths as lines and every other path as a shape', () => {
    expect(layoutObjectKind(path(1, [[0, 0], [10, 0]]))).toBe('Line');
    expect(layoutObjectKind(path(1, [[0, 0], [10, 0]], { handles: [{}, {}] }))).toBe('Line');
    expect(layoutObjectKind(path(1, [[0, 0], [10, 0]], { handles: [{ out: [5, 5] }, {}] }))).toBe('Shape');
    expect(layoutObjectKind(path(1, [[0, 0], [10, 0], [10, 10]]))).toBe('Shape');
    expect(layoutObjectKind(path(1, [[0, 0], [10, 0]], { closed: true }))).toBe('Shape');
    expect(['text', 'label', 'dimension', 'angular-dimension', 'image', 'table'].map(kind => layoutObjectKind(of(1, kind as LayoutEntity['kind']))))
      .toEqual(['Text', 'Label', 'Dimension', 'Dimension', 'Image', 'Table']);
  });

  it('names model views View, numbered apart from pictures', () => {
    const view = (id: number): LayoutEntity => ({ ...of(id, 'image'), image: { src: '', viewport: {} as never } });
    expect(layoutObjectKind(view(1))).toBe('View');
    expect(Object.fromEntries(layoutDefaultObjectNames(stateWith([[of(3, 'image'), view(4), view(5)]]))))
      .toEqual({ 3: 'Image 1', 4: 'View 1', 5: 'View 2' });
  });

  it('numbers each kind from 1 across pages and shared objects in creation order', () => {
    const state = stateWith([[of(9, 'text'), path(5, [[0, 0], [1, 0]]), of(7, 'dimension')], [path(3, [[0, 0], [1, 0]]), of(12, 'text')]],
      [of(6, 'angular-dimension'), path(4, [[0, 0], [1, 0], [1, 1]])]);
    expect(Object.fromEntries(layoutDefaultObjectNames(state))).toEqual({
      3: 'Line 1', 4: 'Shape 1', 5: 'Line 2', 6: 'Dimension 1', 7: 'Dimension 2', 9: 'Text 1', 12: 'Text 2',
    });
  });

  it('keeps numbers when an object is renamed and renumbers later objects only when an earlier one is deleted', () => {
    const state = stateWith([[of(3, 'table'), of(4, 'table'), of(5, 'table')]]);
    const page = state.pages.get(state.pageOrder[0]!)!;
    page.entities.set(3, { ...page.entities.get(3)!, name: 'Schedule' });
    expect(layoutDefaultObjectNames(state).get(4)).toBe('Table 2');
    page.entities.delete(3);
    expect(layoutDefaultObjectNames(state).get(4)).toBe('Table 1');
  });

  it('follows the current geometry, so turning a line into a shape or back changes its kind and number', () => {
    const state = stateWith([[path(2, [[0, 0], [1, 0]]), path(3, [[0, 0], [1, 1], [2, 0]], { closed: true }), path(4, [[0, 0], [2, 0]])]]);
    const page = state.pages.get(state.pageOrder[0]!)!;
    expect(Object.fromEntries(layoutDefaultObjectNames(state))).toEqual({ 2: 'Line 1', 3: 'Shape 1', 4: 'Line 2' });
    page.entities.set(2, { ...page.entities.get(2)!, handles: [{ out: [0.5, 0.5] }, {}] });
    expect(Object.fromEntries(layoutDefaultObjectNames(state))).toEqual({ 2: 'Shape 1', 3: 'Shape 2', 4: 'Line 1' });
    page.entities.set(2, { ...page.entities.get(2)!, handles: [{}, {}] });
    expect(Object.fromEntries(layoutDefaultObjectNames(state))).toEqual({ 2: 'Line 1', 3: 'Shape 1', 4: 'Line 2' });
  });

  it('shows the trimmed custom name, else the default', () => {
    const defaults = new Map([[3, 'Image 1']]);
    expect(layoutObjectName({ ...of(3, 'image'), name: '  Site plan ' }, defaults)).toBe('Site plan');
    expect(layoutObjectName({ ...of(3, 'image'), name: '   ' }, defaults)).toBe('Image 1');
    expect(layoutObjectName(of(3, 'image'), defaults)).toBe('Image 1');
    expect(LAYOUT_OBJECT_NAME_MAX).toBe(100);
  });
});
