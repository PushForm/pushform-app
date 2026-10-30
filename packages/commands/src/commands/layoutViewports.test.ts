// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocument, isViewport, viewportPaperPoint, type LayoutViewportCamera } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

const camera: LayoutViewportCamera = { eye: [10, -10, 8], target: [0, 0, 1], up: [0, 0, 1], projection: 'perspective', fov: 35, scale: 1 };

function withModel() {
  const doc = createLayoutDocument();
  doc.undoStack.transact('Import', draft => {
    draft.modelArchives = new Map([['archive', { format: 'sketchup-layout', archiveBase64: 'UEs=',
      models: new Map([['idModel', { internalTarget: 'ref/house.skp', externalTarget: null }]]),
      viewports: new Map([['id60', { modelReferenceId: 'idModel', entityIds: [] }]]) }]]);
  });
  const { commands } = createLayoutRegistry(doc);
  const pageId = doc.state.pageOrder[0]!;
  const add = () => commands.execute('layout.viewport.add', { pageId, first: [10, 10], second: [110, 60],
    source: { archiveId: 'archive', modelReferenceId: 'idModel' }, camera, scene: 'Front' }) as number;
  const entity = (id: number) => doc.state.pages.get(pageId)!.entities.get(id)!;
  return { doc, commands, pageId, add, entity };
}

describe('Layout model views', () => {
  it('keeps very wide perspective views editable and copyable after preserving scale through a resize', () => {
    const { commands, pageId, add, entity } = withModel(), id = add();
    commands.execute('layout.viewport.setCamera', { pageId, entityId: id, camera: { ...camera, fov: 178 }, scene: null });
    commands.execute('layout.shape.scale', { pageId, entityId: id, scaleX: 1, scaleY: 4, pivot: [10, 10] });
    const resized = entity(id).image!.viewport!.camera;
    expect(resized.fov).toBeGreaterThan(179); expect(resized.fov).toBeLessThan(180);
    commands.execute('layout.viewport.setCamera', { pageId, entityId: id, camera: resized, scene: null });
    const [copy] = commands.execute('layout.clipboard.paste', { pageId, entities: [JSON.parse(JSON.stringify(entity(id)))] }) as number[];
    expect(entity(copy!).image!.viewport!.camera).toEqual(resized);
    expect(() => commands.execute('layout.viewport.setCamera', { pageId, entityId: id, camera: { ...camera, fov: 180 }, scene: null })).toThrow();
  });

  it('changes resize mode undoably, preserves paper positions, and carries the mode through copying', () => {
    const { commands, pageId, add, entity } = withModel(), id = add();
    const paper = () => viewportPaperPoint(entity(id).points, entity(id).image!.viewport!.camera, [0, 0, 1])!;
    const before = paper();
    commands.execute('layout.shape.scale', { pageId, entityId: id, scaleX: 2, scaleY: 2, pivot: [10, 10] });
    expect(paper()[0]).toBeCloseTo(before[0]); expect(paper()[1]).toBeCloseTo(before[1]);
    commands.execute('edit.undo');
    commands.execute('layout.viewport.setResizeMode', { pageId, entityId: id, preserveScale: false });
    const [copy] = commands.execute('layout.clipboard.paste', { pageId, entities: [JSON.parse(JSON.stringify(entity(id)))] }) as number[];
    expect(entity(copy!).image!.viewport!.preserveScaleOnResize).toBe(false);
    commands.execute('edit.undo'); commands.execute('edit.undo');
    expect(entity(id).image!.viewport!.preserveScaleOnResize).toBeUndefined();
  });

  it('adds a view of an embedded model using an imported view of it as the template', () => {
    const { commands, pageId, add, entity } = withModel();
    const id = add();
    expect(entity(id)).toMatchObject({ kind: 'image', points: [[10, 10], [110, 10], [110, 60], [10, 60]],
      image: { src: '', viewport: { templateId: 'id60', originalId: null, scene: 'Front', cache: null, camera } } });
    expect(() => commands.execute('layout.viewport.add', { pageId, first: [0, 0], second: [10, 10],
      source: { archiveId: 'archive', modelReferenceId: 'missing' }, camera })).toThrow('Unknown model');
  });

  it('changes a view camera as one undoable step and keeps a parallel scale when the frame is resized', () => {
    const { commands, pageId, add, entity } = withModel();
    const id = add();
    const parallel = { ...camera, projection: 'parallel' as const, scale: 1 / 48 };
    commands.execute('layout.viewport.setCamera', { pageId, entityId: id, camera: parallel, scene: null });
    expect(entity(id).image!.viewport).toMatchObject({ camera: parallel, scene: null });
    commands.execute('layout.shape.scale', { pageId, entityId: id, scaleX: 2, scaleY: 2, pivot: [10, 10] });
    expect(entity(id).image!.viewport!.camera.scale).toBe(1 / 48);
    commands.execute('edit.undo');
    commands.execute('edit.undo');
    expect(entity(id).image!.viewport).toMatchObject({ camera, scene: 'Front' });
    expect(() => commands.execute('layout.viewport.setCamera', { pageId, entityId: id, camera: { ...camera, fov: 0 }, scene: null })).toThrow();
  });

  it('copies views as independent views of the same model, by move, page duplicate, and paste', () => {
    const { doc, commands, pageId, add, entity } = withModel();
    const id = add();
    doc.undoStack.transact('Pretend imported', draft => { draft.pages.get(pageId)!.entities.get(id)!.image!.viewport!.originalId = 'id60'; });
    const copyId = commands.execute('layout.shape.move', { pageId, entityId: id, delta: [0, 80], copy: true }) as number;
    expect(entity(copyId).image!.viewport).toMatchObject({ originalId: null, templateId: 'id60', source: { modelReferenceId: 'idModel' } });
    expect(entity(id).image!.viewport!.originalId).toBe('id60');
    commands.execute('layout.viewport.setCamera', { pageId, entityId: copyId, camera: { ...camera, fov: 20 }, scene: null });
    expect(entity(id).image!.viewport!.camera.fov).toBe(35);
    const pageCopy = commands.execute('layout.page.duplicate', { pageId }) as number;
    const duplicated = [...doc.state.pages.get(pageCopy)!.entities.values()].filter(isViewport);
    expect(duplicated).toHaveLength(2);
    expect(duplicated.every(view => view.image.viewport.originalId === null)).toBe(true);
    const [pasted] = commands.execute('layout.clipboard.paste', { pageId, entities: [JSON.parse(JSON.stringify(entity(id)))] }) as number[];
    expect(entity(pasted!).image!.viewport).toMatchObject({ originalId: null, templateId: 'id60' });
  });

  it('pastes a view into a document without its model as its picture alone', () => {
    const { entity, add } = withModel();
    const view = JSON.parse(JSON.stringify(entity(add())));
    const other = createLayoutDocument(), { commands } = createLayoutRegistry(other), pageId = other.state.pageOrder[0]!;
    expect(() => commands.execute('layout.clipboard.paste', { pageId, entities: [view] })).toThrow('Nothing to paste');
    view.image.src = 'data:image/png;base64,AAAA';
    const [id] = commands.execute('layout.clipboard.paste', { pageId, entities: [view] }) as number[];
    expect(other.state.pages.get(pageId)!.entities.get(id!)!.image).toEqual({ src: 'data:image/png;base64,AAAA' });
  });
});

describe('Cloud model references', () => {
  const sha = 'a'.repeat(64), newer = 'b'.repeat(64);
  const link = (commands: ReturnType<typeof createLayoutRegistry>['commands'], documentId = 'doc-1') =>
    commands.execute('layout.reference.add', { displayName: 'House', documentId, revisionId: 'rev-1', revisionNumber: 1, sha256: sha }) as number;
  const picture = 'data:image/png;base64,AAAA';

  it('links a cloud model once per document and adds views of it without a LayOut template', () => {
    const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
    const referenceId = link(commands);
    expect(link(commands)).toBe(referenceId);
    expect(doc.state.references.get(referenceId)).toMatchObject({ displayName: 'House', target: { kind: 'cloud', documentId: 'doc-1', revisionNumber: 1, sha256: sha, pinned: false } });
    const id = commands.execute('layout.viewport.add', { pageId, first: [10, 10], second: [110, 60], source: { referenceId }, camera, scene: null }) as number;
    expect(doc.state.pages.get(pageId)!.entities.get(id)!.image).toMatchObject({ src: '', viewport: { source: { referenceId }, templateId: null, originalId: null, cache: null } });
    expect(() => commands.execute('layout.viewport.add', { pageId, first: [0, 0], second: [10, 10], source: { referenceId: 99 }, camera })).toThrow('Unknown model');
    commands.execute('edit.undo'); commands.execute('edit.undo');
    expect(doc.state.references.size).toBe(0);
  });

  it('follows the latest revision without an undo step unless pinned; pinned references update explicitly', () => {
    const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc);
    const referenceId = link(commands);
    const target = () => doc.state.references.get(referenceId)!.target as { revisionId: string; revisionNumber: number; sha256: string; pinned: boolean };
    const version = doc.version;
    expect(commands.execute('layout.reference.follow', { referenceId, revisionId: 'rev-2', revisionNumber: 2, sha256: newer })).toBe(true);
    expect(target()).toMatchObject({ revisionId: 'rev-2', revisionNumber: 2, sha256: newer });
    expect(doc.version).toBeGreaterThan(version);
    expect(doc.undoStack.canUndo).toBe(true);
    commands.execute('edit.undo');
    // Undo reverts the link, not the automatic follow: the reference is gone altogether.
    expect(doc.state.references.size).toBe(0);
    commands.execute('edit.redo');
    commands.execute('layout.reference.pin', { referenceId, pinned: true });
    expect(commands.execute('layout.reference.follow', { referenceId, revisionId: 'rev-3', revisionNumber: 3, sha256: 'c'.repeat(64) })).toBe(false);
    expect(target().revisionId).toBe('rev-1');
    commands.execute('layout.reference.update', { referenceId, revisionId: 'rev-3', revisionNumber: 3, sha256: 'c'.repeat(64) });
    expect(target()).toMatchObject({ revisionId: 'rev-3', pinned: true });
    commands.execute('edit.undo');
    expect(target().revisionId).toBe('rev-1');
  });

  it('stores a finished render as derived data: saved with the document, outside the undo history', () => {
    const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
    const referenceId = link(commands);
    const id = commands.execute('layout.viewport.add', { pageId, first: [10, 10], second: [110, 60], source: { referenceId }, camera, scene: null }) as number;
    const cache = { camera, widthMm: 100, heightMm: 50, sha256: sha };
    commands.execute('layout.viewport.snapshot', { pageId, entityId: id, src: picture, cache });
    const image = () => doc.state.pages.get(pageId)!.entities.get(id)?.image;
    expect(image()).toMatchObject({ src: picture, viewport: { cache } });
    expect(() => commands.execute('layout.viewport.snapshot', { pageId, entityId: id, src: 'blob:nope', cache })).toThrow();
    commands.execute('edit.undo');
    expect(image()).toBeUndefined();
    commands.execute('edit.redo');
    expect(image()).toMatchObject({ src: '', viewport: { cache: null } });
  });

  it('relinks every view of an embedded model to a cloud reference, keeping their pictures as current', () => {
    const { doc, commands, pageId, add, entity } = withModel();
    const first = add(), second = add();
    const cache = { camera, widthMm: 100, heightMm: 50 };
    doc.undoStack.transact('Picture', draft => { const image = draft.pages.get(pageId)!.entities.get(first)!.image!; image.src = picture; image.viewport!.cache = cache; });
    const referenceId = link(commands);
    expect(commands.execute('layout.viewport.relink', { source: { archiveId: 'archive', modelReferenceId: 'idModel' }, referenceId })).toBe(2);
    expect(entity(first).image).toMatchObject({ src: picture, viewport: { source: { referenceId }, templateId: null, originalId: null, cache: { ...cache, sha256: sha } } });
    expect(entity(second).image!.viewport).toMatchObject({ source: { referenceId }, cache: null });
    expect(doc.state.modelArchives?.size).toBe(1);
    commands.execute('edit.undo');
    expect(entity(first).image!.viewport).toMatchObject({ source: { archiveId: 'archive', modelReferenceId: 'idModel' }, templateId: 'id60', cache });
  });

  it('pastes a cloud view into another drawing through a reference to the same model, created from the copy when missing', () => {
    const from = createLayoutDocument(), source = createLayoutRegistry(from).commands;
    const referenceId = link(source), pageId = from.state.pageOrder[0]!;
    const id = source.execute('layout.viewport.add', { pageId, first: [10, 10], second: [110, 60], source: { referenceId }, camera, scene: null }) as number;
    const copied = JSON.parse(JSON.stringify(from.state.pages.get(pageId)!.entities.get(id)!));
    copied.image.viewport.source = { referenceId, reference: { displayName: 'House', target: from.state.references.get(referenceId)!.target } };
    const to = createLayoutDocument(), target = createLayoutRegistry(to).commands, toPage = to.state.pageOrder[0]!;
    const [pasted] = target.execute('layout.clipboard.paste', { pageId: toPage, entities: [copied] }) as number[];
    const reference = [...to.state.references.values()][0]!;
    expect(reference).toMatchObject({ displayName: 'House', target: { kind: 'cloud', documentId: 'doc-1' } });
    expect(to.state.pages.get(toPage)!.entities.get(pasted!)!.image!.viewport!.source).toEqual({ referenceId: reference.id });
    // A second paste reuses the reference; a copy without its reference keeps only its picture.
    target.execute('layout.clipboard.paste', { pageId: toPage, entities: [copied] });
    expect(to.state.references.size).toBe(1);
    const bare = { ...copied, image: { ...copied.image, src: picture, viewport: { ...copied.image.viewport, source: { referenceId: 42 } } } };
    const [plain] = target.execute('layout.clipboard.paste', { pageId: toPage, entities: [bare] }) as number[];
    expect(to.state.pages.get(toPage)!.entities.get(plain!)!.image!.viewport).toBeUndefined();
  });
});
