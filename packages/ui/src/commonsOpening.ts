// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { newGuid, m4identity } from '@pushform/core';
import { createDefinition, newInstance, copyModelSelection, clipboardRefs, modelClipboard, type ModelClipboard } from '@pushform/commands';
import { Document, createDocument, ImageStore, parseModelAttributions, type DocumentState } from '@pushform/model';
import { applySketchUpImport, openModelFile, readSketchUpInWorker, modelArchiveImages, modelImportBaseName, type MeshImportOptions, type OpenedModelFile } from '@pushform/io';
import type { OpenedCommonsModel } from '@pushform/cloud';
import type { DocumentSession, ModelTab } from './session';

/** Decode/convert completely, retain notices, then install one new unsaved copy. */
export async function prepareCommonsModel(source: OpenedCommonsModel, signal: AbortSignal, mesh?: MeshImportOptions) {
  signal.throwIfAborted();
  let prepared: Pick<OpenedModelFile, 'state'|'images'>; let warnings: string[] = [];
  if (/\.pf$/i.test(source.name)) prepared = await openModelFile(source.bytes);
  else {
    const scene = await readSketchUpInWorker(source.bytes, { signal, ...(mesh ? { mesh } : {}) });
    signal.throwIfAborted();
    const doc = createDocument(), images = new ImageStore();
    const report = doc.transact('Open community model', draft => applySketchUpImport(draft, scene, { images })).value;
    warnings = report.warnings;
    prepared = { state: doc.state, images: new Map(modelArchiveImages(doc.state, images).map(image => [image.id, image.blob])) };
  }
  signal.throwIfAborted();
  const doc = new Document(prepared.state);
  doc.transact('Retain community model notices', draft => {
    draft.meta.guid = newGuid();
    const existing = draft.meta.attributions ?? [];
    draft.meta.attributions = parseModelAttributions([...existing.filter(a => !(a.modelId === source.attribution.modelId && a.revision === source.attribution.revision && a.assetId === source.attribution.assetId)), source.attribution]);
  });
  signal.throwIfAborted();
  return { state: doc.state, images: prepared.images, warnings };
}

export async function openCommonsModel(session: DocumentSession, source: OpenedCommonsModel, signal: AbortSignal, mesh?: MeshImportOptions): Promise<{ tab: ModelTab; warnings: string[] }> {
  const prepared = await prepareCommonsModel(source, signal, mesh);
  signal.throwIfAborted();
  return { tab: session.openModelCopy(prepared, modelImportBaseName(source.name) + '.pf'), warnings: prepared.warnings };
}

/** Decode in isolation, wrap the source as one component, then use the editor's undoable placement tool. */
export async function placeCommonsModel(session: DocumentSession, tab: ModelTab, source: OpenedCommonsModel, signal: AbortSignal, mesh?: MeshImportOptions) {
  const path = [...tab.app.document.context.path];
  const prepared = await prepareCommonsModel(source, signal, mesh);
  signal.throwIfAborted();
  if (!session.tabs.includes(tab) || tab.app.document.context.path.join('/') !== path.join('/')) throw new Error('The insertion destination changed. Choose it again.');
  const isolated = new Document(prepared.state);
  isolated.transact('Prepare community component', draft => {
    const state = draft as unknown as DocumentState;
    const root = state.definitions.get(state.rootDefinitionId)!;
    const component = createDefinition(draft, { name: source.attribution.title, isGroup: false });
    component.entities = root.entities;
    root.entities = createDefinition(draft, { name: 'Placement root', isGroup: true }).entities;
    const instance = newInstance(draft, component.id, m4identity(), source.attribution.title);
    root.entities.instances.set(instance.id, instance);
  });
  const images = new ImageStore(); for (const [id, blob] of prepared.images) images.register(prepared.state.images.get(id)!, blob.bytes, blob.mime);
  const state = isolated.state;
  const holder = { state } as ModelClipboard;
  const clip = copyModelSelection(state, [], clipboardRefs(holder), { images });
  if (!clip) throw new Error('This model has no placeable geometry.');
  session.activate(tab.id); modelClipboard.set({ ...clip, insertionPoint: [...clip.bounds.min], destination: { guid: tab.app.document.doc.state.meta.guid, path } }); tab.app.commands.execute('edit.paste');
}
