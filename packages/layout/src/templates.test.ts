// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutTemplateState, DEFAULT_LAYOUT_TEMPLATE_ID, LAYOUT_TEMPLATES } from './templates';
import { LayoutDocument, entitiesForLayer } from './LayoutDocument';
import { resolveLayoutText } from './text';

it('provides distinct paper templates with exact dimensions, units, and grid settings', () => {
  expect(new Set(LAYOUT_TEMPLATES.map(t => t.id)).size).toBe(LAYOUT_TEMPLATES.length);
  expect(new Set(LAYOUT_TEMPLATES.map(t => `${t.category}/${t.section}/${t.name}`)).size).toBe(LAYOUT_TEMPLATES.length);
  const metric = createLayoutTemplateState(DEFAULT_LAYOUT_TEMPLATE_ID);
  expect(metric.pages.get(metric.pageOrder[0]!)!.size).toEqual([297, 210]);
  expect(metric.settings.grid).toMatchObject({ show: true, spacingMm: 5 });
  const imperial = createLayoutTemplateState('graph-letter-portrait-div8');
  expect(imperial.pages.get(imperial.pageOrder[0]!)!.size).toEqual([215.9, 279.4]);
  expect(imperial.settings.units).toBe('inch'); expect(imperial.settings.grid.spacingMm).toBe(3.175);
  const plain = createLayoutTemplateState('plain-tabloid-landscape');
  expect(plain.settings.grid.show).toBe(false); expect(plain.pages.get(plain.pageOrder[0]!)!.size).toEqual([431.8, 279.4]);
  expect(() => createLayoutTemplateState('missing')).toThrow('Unknown');
});

it('instantiates every template as an editable clean document with native geometry and text', () => {
  for (const template of LAYOUT_TEMPLATES) {
    const doc = new LayoutDocument(createLayoutTemplateState(template.id)), state = doc.state, page = state.pages.get(state.pageOrder[0]!)!;
    expect(doc.undoStack.canUndo).toBe(false); expect(state.layers.get(state.activeLayerId)!.name).toBe('Layer 1');
    expect(page.size).toEqual(template.size);
    expect(page.entityOrder).toHaveLength(page.entities.size);
    const entities = state.layerOrder.flatMap(id => entitiesForLayer(page, state, id));
    for (const entity of entities) {
      expect(state.layers.get(entity.layerId)?.locked).toBe(false);
      expect(entity.points.every(p => p.every(Number.isFinite))).toBe(true);
      expect(entity.id).toBeLessThan(state.meta.nextId);
    }
    if (template.category === 'Paper') {
      expect(entities).toHaveLength(0);
      expect([...state.layers.values()].some(layer => layer.name === 'Frame')).toBe(false);
    } else {
      const frame = [...state.layers.values()].find(layer => layer.name === 'Frame')!;
      expect(frame).toMatchObject({ shared: true, visible: true, locked: false });
      expect(state.layerOrder.indexOf(state.activeLayerId)).toBeGreaterThan(state.layerOrder.indexOf(frame.id));
      expect(page.entities.size).toBe(0);
      expect(state.sharedEntities.size).toBeGreaterThan(0);
      expect(state.sharedEntityOrder).toHaveLength(state.sharedEntities.size);
      expect(entities.every(entity => entity.layerId === frame.id)).toBe(true);
    }
    if (template.frames) expect(entities.filter(e => e.kind === 'path')).toHaveLength(template.frames[0] * template.frames[1]);
    if (template.category === 'Titleblock') {
      const text = entities.flatMap(e => e.text ? [resolveLayoutText(e.text.content, page, state)] : []);
      expect(text).toContain('Project name'); expect(text).toContain('SHEET 1 / 1');
    }
  }
});

it('shows the same Frame content on added pages while resolving page fields independently', () => {
  const doc = new LayoutDocument(createLayoutTemplateState('titleblock-a4'));
  const frame = [...doc.state.layers.values()].find(layer => layer.name === 'Frame')!;
  const firstId = doc.state.pageOrder[0]!;
  const secondId = doc.addPage('Details');
  const first = doc.state.pages.get(firstId)!, second = doc.state.pages.get(secondId)!;
  const firstContent = entitiesForLayer(first, doc.state, frame.id), secondContent = entitiesForLayer(second, doc.state, frame.id);
  expect(secondContent).toEqual(firstContent);
  expect(second.entities.size).toBe(0);
  const sheet = secondContent.find(entity => entity.text?.content.startsWith('SHEET'))!;
  expect(resolveLayoutText(sheet.text!.content, first, doc.state)).toBe('SHEET 1 / 2');
  expect(resolveLayoutText(sheet.text!.content, second, doc.state)).toBe('SHEET 2 / 2');
});
