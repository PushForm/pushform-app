// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import type { Id } from '@pushform/core';
import { createDocument } from '@pushform/model';
import { createLayoutDocument, formatLinearDimension, layoutTextStyleAt, resolveLayoutText, type LayoutModelAttachment } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

function setup() {
  const model = createDocument(), doc = createLayoutDocument();
  model.transact('Vertices', draft => {
    const vertices = draft.definitions.get(draft.rootDefinitionId)!.entities.sketch.vertices;
    vertices.set(100 as Id, { id: 100 as Id, p: [0, 0, 0] });
    vertices.set(101 as Id, { id: 101 as Id, p: [2, 0, 0] });
  });
  const pageId = doc.state.pageOrder[0]!;
  let viewportId = 0;
  doc.undoStack.transact('View', draft => {
    viewportId = draft.meta.nextId++;
    const page = draft.pages.get(pageId)!;
    page.entities.set(viewportId, { id: viewportId, layerId: draft.activeLayerId, kind: 'image', closed: true,
      points: [[0, 0], [100, 0], [100, 100], [0, 100]], image: { src: '', viewport: {
        source: { referenceId: 7 }, templateId: null, originalId: null, cache: null, scene: null, background: null,
        camera: { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 30, scale: 0.02, projection: 'parallel' },
      } } });
    page.entityOrder.push(viewportId);
  });
  const { commands, host } = createLayoutRegistry(doc);
  host.annotationModels = () => model.state;
  const entityId = commands.execute('layout.dimension.add', { pageId, points: [[50, 50], [90, 50], [50, 70]] }) as number;
  const attachments: LayoutModelAttachment[] = [100, 101].map(id => ({ viewportId, source: { referenceId: 7 },
    modelGuid: model.state.meta.guid, anchor: { kind: 'sketchVertex', path: [], id: id as Id } }));
  const entity = () => doc.state.pages.get(pageId)!.entities.get(entityId)!;
  const attach = () => commands.execute('layout.annotation.attachModel', { pageId, entityId, attachments });
  return { doc, model, commands, host, pageId, entityId, viewportId, attachments, entity, attach };
}

it('attaches, follows model edits, disconnects without changing the shown value, and undoes', () => {
  const { model, commands, pageId, entityId, entity, attach } = setup();
  attach();
  expect(formatLinearDimension(entity().dimension!)).toBe('2000.0 mm');
  model.transact('Move', draft => { draft.definitions.get(draft.rootDefinitionId)!.entities.sketch.vertices.get(101 as Id)!.p = [3, 0, 0]; });
  commands.execute('layout.annotation.refreshModels', {});
  expect(entity().points[1]![0]).toBeCloseTo(110);
  expect(entity().points[1]![1]).toBeCloseTo(50);
  expect(formatLinearDimension(entity().dimension!)).toBe('3000.0 mm');
  commands.execute('layout.annotation.detachModel', { pageId, entityId });
  expect(entity().modelAnnotation).toBeUndefined();
  expect(formatLinearDimension(entity().dimension!)).toBe('3000.0 mm');
  commands.execute('edit.undo');
  expect(entity().modelAnnotation?.status).toBe('resolved');
});

it('explicitly replaces or disconnects an imported connection, restoring its provenance on undo', () => {
  const { doc, commands, pageId, entityId, viewportId, entity, attach } = setup();
  const saved = { archiveId: 'original', originalId: 'id50', snapshot: 'imported', viewports: [{ originalId: 'id40', entityId: viewportId }] };
  doc.undoStack.transact('Imported connection', state => {
    state.pages.get(pageId)!.entities.get(entityId)!.preservedModelConnections = saved;
  });
  attach();
  expect(entity().preservedModelConnections).toBeUndefined();
  expect(entity().modelAnnotation?.status).toBe('resolved');
  commands.execute('edit.undo');
  expect(entity().preservedModelConnections).toEqual(saved);
  expect(entity().modelAnnotation).toBeUndefined();
  const measurement = formatLinearDimension(entity().dimension!);
  commands.execute('layout.annotation.detachModel', { pageId, entityId });
  expect(entity().preservedModelConnections).toBeUndefined();
  expect(formatLinearDimension(entity().dimension!)).toBe(measurement);
  commands.execute('edit.undo');
  expect(entity().preservedModelConnections).toEqual(saved);
});

it('preserves the complete last result on deletion or an unavailable revision', () => {
  const { model, commands, host, entity, attach } = setup();
  attach();
  host.annotationModels = () => undefined;
  commands.execute('layout.annotation.refreshModels', {});
  expect(entity().modelAnnotation?.status).toBe('unavailable');
  expect(entity().dimension).toMatchObject({ cachedValueMm: 40, scale: 0.02, detached: false });
  host.annotationModels = () => model.state;
  model.transact('Delete', draft => { draft.definitions.get(draft.rootDefinitionId)!.entities.sketch.vertices.delete(101 as Id); });
  commands.execute('layout.annotation.refreshModels', {});
  expect(entity().modelAnnotation?.status).toBe('detached');
  expect(entity().points.slice(0, 2)).toEqual([[50, 50], [90, 50]]);
  expect(entity().dimension).toMatchObject({ cachedValueMm: 40, scale: 0.02, detached: true });
});

it('rejects unresolved and cross-view attachments atomically', () => {
  const { commands, pageId, entityId, attachments, entity, host, attach } = setup();
  const before = entity();
  attachments[1]!.viewportId++;
  expect(() => attach()).toThrow();
  expect(entity()).toEqual(before);
  expect(() => commands.execute('layout.annotation.attachModel', { pageId, entityId, attachments: [null] })).toThrow();
  attachments[1]!.viewportId--;
  host.annotationModels = () => undefined;
  expect(() => attach()).toThrow('unavailable');
  expect(entity()).toEqual(before);
});

it('matches LayOut projected parallel measurement and true perspective distance', () => {
  const { doc, model, commands, pageId, viewportId, entity, attach } = setup();
  model.transact('Raise endpoint', draft => {
    draft.definitions.get(draft.rootDefinitionId)!.entities.sketch.vertices.get(101 as Id)!.p = [2, 0, 2];
  });
  attach();
  expect(formatLinearDimension(entity().dimension!)).toBe('2000.0 mm');
  doc.undoStack.transact('View scale', draft => {
    draft.pages.get(pageId)!.entities.get(viewportId)!.image!.viewport!.camera.scale = 0.04;
  });
  commands.execute('layout.annotation.refreshModels', {});
  expect(formatLinearDimension(entity().dimension!)).toBe('2000.0 mm');
  expect(entity().dimension!.scale).toBe(0.04);
  doc.undoStack.transact('Perspective', draft => {
    draft.pages.get(pageId)!.entities.get(viewportId)!.image!.viewport!.camera.projection = 'perspective';
  });
  commands.execute('layout.annotation.refreshModels', {});
  expect(formatLinearDimension(entity().dimension!)).toBe('2828.4 mm');
  expect(entity().dimension!.scale).toBe(1);
});

it('updates model label Auto-Text and freezes its last displayed values with formatting on disconnect', () => {
  const { model, doc, commands, host, pageId, attachments } = setup();
  model.transact('Metric source', state => { state.meta.units.format = 'decimal'; state.meta.units.lengthUnit = 'm'; state.meta.units.lengthPrecision = 2; });
  const content = 'X=<Coordinates(x)>; <Ratio>; <Unknown>';
  const labelId = commands.execute('layout.text.add', { pageId, kind: 'label', points: [[55, 55], [100, 65], [50, 50]],
    modelAttachments: [attachments[0]], text: { content, fontFamily: 'Arial', fontSizePt: 10, color: '#000000', bold: false,
      italic: false, underline: false, align: 'left', vertical: 'top', bounded: true, leader: 'elbow', endpoint: 'arrow',
      spans: [{ start: 2, end: 18, bold: true, italic: false, underline: true }] } }) as number;
  const label = () => doc.state.pages.get(pageId)!.entities.get(labelId)!;
  const shown = () => resolveLayoutText(label().text!.content, doc.state.pages.get(pageId)!, doc.state, label().modelAnnotation?.fields);
  expect(shown()).toBe('X=0.00m; 1:50; <Unknown>');
  model.transact('Move vertex', state => { state.definitions.get(state.rootDefinitionId)!.entities.sketch.vertices.get(100 as Id)!.p = [1, 0, 0]; });
  commands.execute('layout.annotation.refreshModels', {});
  expect(shown()).toBe('X=1.00m; 1:50; <Unknown>');
  host.annotationModels = () => undefined;
  commands.execute('layout.annotation.refreshModels', {});
  expect(label().modelAnnotation?.status).toBe('unavailable');
  expect(shown()).toBe('X=1.00m; 1:50; <Unknown>');
  commands.execute('layout.annotation.detachModel', { pageId, entityId: labelId });
  expect(label().modelAnnotation).toBeUndefined();
  expect(label().text!.content).toBe('X=1.00m; 1:50; <Unknown>');
  expect(layoutTextStyleAt(label().text!, 2)).toMatchObject({ bold: true, underline: true });
  expect(layoutTextStyleAt(label().text!, 9)).toMatchObject({ bold: false, underline: false });
  commands.execute('edit.undo');
  expect(label().text!.content).toBe(content);
  expect(label().modelAnnotation?.status).toBe('unavailable');
});

it('makes Move-tool dimension copies independent while preserving perspective measurements', () => {
  const { doc, model, commands, pageId, entityId, viewportId, entity, attach } = setup();
  model.transact('Raised vertex', state => { state.definitions.get(state.rootDefinitionId)!.entities.sketch.vertices.get(101 as Id)!.p = [2, 0, 2]; });
  doc.undoStack.transact('Perspective', state => { state.pages.get(pageId)!.entities.get(viewportId)!.image!.viewport!.camera.projection = 'perspective'; });
  attach();
  const original = entity();
  const copiedId = commands.execute('layout.shape.move', { pageId, entityId, delta: [10, 20], copy: true, whole: true }) as number;
  const copied = () => doc.state.pages.get(pageId)!.entities.get(copiedId)!;
  expect(copied().modelAnnotation).toBeUndefined();
  expect(copied().points).toEqual(original.points.map(([x, y]) => [x + 10, y + 20]));
  expect(formatLinearDimension(copied().dimension!)).toBe(formatLinearDimension(original.dimension!));
  model.transact('Move source', state => { state.definitions.get(state.rootDefinitionId)!.entities.sketch.vertices.get(101 as Id)!.p = [3, 0, 2]; });
  commands.execute('layout.annotation.refreshModels', {});
  expect(formatLinearDimension(copied().dimension!)).toBe('2828.4 mm');
  expect(formatLinearDimension(entity().dimension!)).toBe('3605.6 mm');
});

it('stretches a model label leader, detaches a tip drag, and reconnects on undo', () => {
  const { doc, commands, pageId, attachments } = setup();
  const labelId = commands.execute('layout.text.add', { pageId, kind: 'label', points: [[55, 55], [100, 65], [50, 50]],
    modelAttachments: [attachments[0]], text: { content: '<Ratio>', fontFamily: 'Arial', fontSizePt: 10, color: '#000000', bold: false,
      italic: false, underline: false, align: 'left', vertical: 'top', bounded: true, leader: 'elbow', endpoint: 'arrow' } }) as number;
  const label = () => doc.state.pages.get(pageId)!.entities.get(labelId)!;
  commands.execute('layout.shape.move', { pageId, entityId: labelId, delta: [10, 20], labelPart: 'leader' });
  expect(label().points).toEqual([[65, 75], [110, 85], [50, 50]]);
  expect(label().modelAnnotation?.status).toBe('resolved');
  commands.execute('layout.shape.move', { pageId, entityId: labelId, delta: [5, 10], labelPart: 'tip' });
  expect(label().points).toEqual([[70, 85], [115, 95], [55, 60]]);
  expect(label().modelAnnotation).toBeUndefined();
  expect(label().text!.content).toBe('1:50');
  commands.execute('edit.undo');
  expect(label().modelAnnotation?.status).toBe('resolved');
  expect(label().text!.content).toBe('<Ratio>');
});

it('copies a model label with its view, but freezes a standalone whole-label copy', () => {
  const { doc, commands, pageId, viewportId, attachments } = setup();
  const labelId = commands.execute('layout.text.add', { pageId, kind: 'label', points: [[55, 55], [100, 65], [50, 50]],
    modelAttachments: [attachments[0]], text: { content: '<Ratio>', fontFamily: 'Arial', fontSizePt: 10, color: '#000000', bold: false,
      italic: false, underline: false, align: 'left', vertical: 'top', bounded: true, leader: 'elbow', endpoint: 'arrow' } }) as number;
  const alone = commands.execute('layout.shape.move', { pageId, entityId: labelId, delta: [10, 20], copy: true, whole: true }) as number;
  expect(doc.state.pages.get(pageId)!.entities.get(alone)).toMatchObject({ points: [[65, 75], [110, 85], [60, 70]], text: { content: '1:50' } });
  expect(doc.state.pages.get(pageId)!.entities.get(alone)!.modelAnnotation).toBeUndefined();
  const [copiedLabel, copiedView] = commands.execute('layout.shape.move', { pageId, entityIds: [labelId, viewportId], delta: [10, 20], copy: true, whole: true }) as number[];
  const result = doc.state.pages.get(pageId)!.entities.get(copiedLabel!)!;
  expect(result.modelAnnotation).toMatchObject({ status: 'resolved', attachments: [{ viewportId: copiedView }] });
  expect(result.points).toEqual([[65, 75], [110, 85], [60, 70]]);
  expect(result.text!.content).toBe('<Ratio>');
});

it('freezes preserved model label fields on disconnect and page duplication, retaining the template on undo', () => {
  const { doc, commands, pageId, viewportId } = setup();
  const labelId = commands.execute('layout.text.add', { pageId, kind: 'label', points: [[55, 55], [100, 65], [50, 50]],
    text: { content: '<Ratio>', fontFamily: 'Arial', fontSizePt: 10, color: '#000000', bold: true,
      italic: false, underline: false, align: 'left', vertical: 'top', bounded: true, leader: 'elbow', endpoint: 'arrow' } }) as number;
  doc.undoStack.transact('Imported model cache', state => {
    state.pages.get(pageId)!.entities.get(labelId)!.preservedModelConnections = { archiveId: 'original', originalId: 'id40',
      snapshot: 'unchanged', viewports: [{ originalId: 'id20', entityId: viewportId }], fields: { Ratio: '1:10' } };
  });
  const label = () => doc.state.pages.get(pageId)!.entities.get(labelId)!;
  commands.execute('layout.annotation.detachModel', { pageId, entityId: labelId });
  expect(label().text!.content).toBe('1:10');
  expect(layoutTextStyleAt(label().text!, 0).bold).toBe(true);
  expect(label().preservedModelConnections).toBeUndefined();
  commands.execute('edit.undo');
  expect(label().text!.content).toBe('<Ratio>');
  expect(label().preservedModelConnections!.fields).toEqual({ Ratio: '1:10' });
  const copiedPage = commands.execute('layout.page.duplicate', { pageId }) as number;
  const copied = [...doc.state.pages.get(copiedPage)!.entities.values()].find(entity => entity.kind === 'label')!;
  expect(copied.text!.content).toBe('1:10');
  expect(copied.preservedModelConnections).toBeUndefined();
  expect(label().text!.content).toBe('<Ratio>');
});
