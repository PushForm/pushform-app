// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { newGuid } from '@pushform/core';
import { Document, createDocument, ImageStore, parseModelAttributions } from '@pushform/model';
import { applySketchUpImport, openModelFile, readSketchUpInWorker, modelArchiveImages, modelImportBaseName, type MeshImportOptions, type OpenedModelFile } from '@pushform/io';
import type { OpenedCommonsModel } from '@pushform/cloud';
import type { DocumentSession, ModelTab } from './session';

/** Decode/convert completely, retain notices, then install one new unsaved copy. */
export async function openCommonsModel(session: DocumentSession, source: OpenedCommonsModel, signal: AbortSignal, mesh?: MeshImportOptions): Promise<{ tab: ModelTab; warnings: string[] }> {
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
  return { tab: session.openModelCopy({ state: doc.state, images: prepared.images }, modelImportBaseName(source.name) + '.pf'), warnings };
}
