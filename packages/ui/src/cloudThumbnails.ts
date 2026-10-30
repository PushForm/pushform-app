// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CloudFile, CloudFilesApi } from '@pushform/cloud';
import { openLayoutFile, openModelFile } from '@pushform/io';
import { ImageStore, type DocumentState } from '@pushform/model';
import type { LayoutDocumentState } from '@pushform/layout';
import { Viewport, type CameraState } from '@pushform/render';
import type { DocumentSession } from './session';
import { cloudLocation } from './cloudDocuments';
import { withRenderImageStore, bodiesToRender, sketchesToRender, imagesToRender, dimensionsToRender, textsToRender, guidesToRender } from './engine/renderAdapter';
import { sectionsToRender } from './engine/sectionAdapter';
import { applyDocumentView } from './engine/viewSync';
import { paintPrintPage } from './components/LayoutWorkspace';
import { prepareLayoutPages } from './components/layoutPrint';

export const THUMBNAIL_WIDTH = 480, THUMBNAIL_HEIGHT = 360;
export const THUMBNAIL_QUALITY = 0.8;
const MM_PER_INCH = 25.4;

async function jpeg(picture: HTMLCanvasElement): Promise<Uint8Array | null> {
  if (!picture.width || !picture.height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = THUMBNAIL_WIDTH; canvas.height = THUMBNAIL_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / picture.width, canvas.height / picture.height);
  const w = picture.width * scale, h = picture.height * scale;
  ctx.drawImage(picture, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', THUMBNAIL_QUALITY));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

export async function layoutThumbnail(state: LayoutDocumentState): Promise<Uint8Array | null> {
  const page = state.pages.get(state.pageOrder[0]!);
  if (!page) return null;
  await prepareLayoutPages(state, [page.id]);
  const picture = document.createElement('canvas');
  const dpi = Math.min(THUMBNAIL_WIDTH / (page.size[0] / MM_PER_INCH), THUMBNAIL_HEIGHT / (page.size[1] / MM_PER_INCH));
  paintPrintPage(picture, page, state, dpi);
  return jpeg(picture);
}

/** An independent viewport: never changes the editor's camera, selection, tools, or document. */
async function modelThumbnail(state: DocumentState, images: ImageStore, camera?: CameraState): Promise<Uint8Array | null> {
  await document.fonts?.ready;
  const viewport = new Viewport();
  try {
    if (!viewport.mountOffscreen()) return null;
    withRenderImageStore(images, () => {
      viewport.setBodies(bodiesToRender(state));
      viewport.setSketches(sketchesToRender(state));
    });
    viewport.setImages(imagesToRender(state, images));
    viewport.setSections(sectionsToRender(state));
    viewport.setDimensions(dimensionsToRender(state));
    viewport.setTexts(textsToRender(state));
    viewport.setGuides(guidesToRender(state));
    applyDocumentView(viewport, state);
    viewport.camera.setSize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    if (camera) viewport.camera.setState(camera); else viewport.camera.zoomExtents();
    await viewport.sceneSync.textures.whenReady();
    const picture = document.createElement('canvas');
    return viewport.snapshotInto(picture, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, viewport.camera.getState(), { background: '#ffffff' }) ? await jpeg(picture) : null;
  } finally {
    const renderer = viewport.renderer;
    viewport.dispose(); renderer?.forceContextLoss();
  }
}

/** Use an exact, clean local revision when available (also offline), otherwise load saved bytes. */
export async function renderCloudThumbnail(api: CloudFilesApi, session: DocumentSession, ownerId: string, file: CloudFile): Promise<Uint8Array | null> {
  const local = session.tabs.find(tab => {
    const location = cloudLocation(tab.identity);
    return location?.ownerId === ownerId && location.fileId === file.id && location.revisionId === file.current_revision_id && !session.isDirty(tab);
  });
  if (local?.type === 'layout') return layoutThumbnail(local.doc.state);
  const images = new ImageStore();
  try {
    if (local?.type === 'model') {
      const state = local.app.document.doc.state, camera = local.app.viewport.camera.getState();
      for (const [id, asset] of state.images) {
        const blob = local.app.document.images.get(id);
        if (blob) images.register(asset, blob.bytes, blob.mime);
      }
      return await modelThumbnail(state, images, camera);
    }
    if (navigator.onLine === false) return null;
    const opened = await api.openRevision(file.current_revision_id);
    if (opened.file.id !== file.id || opened.revision.id !== file.current_revision_id) return null;
    if (file.kind === 'layout') return layoutThumbnail((await openLayoutFile(opened.bytes)).state);
    const model = await openModelFile(opened.bytes);
    for (const [id, blob] of model.images) {
      const asset = model.state.images.get(id);
      if (asset) images.register(asset, blob.bytes, blob.mime);
    }
    return await modelThumbnail(model.state, images);
  } finally { images.clear(); }
}
