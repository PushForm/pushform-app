// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { invoke, isTauri } from '@tauri-apps/api/core';
import { writeLayoutSvg } from '@pushform/io';
import type { LayoutDocumentState, LayoutEntity, LayoutPage } from '@pushform/layout';
import { drawLayoutVectorPage } from './layoutVectorDrawing';
import { LAYOUT_CLIPBOARD_TYPE } from './layoutClipboard';

export interface LayoutClipboardPayload { native: string; svg: string; html: string; text: string }

/** One copy carries native objects and a portable, selection-only vector drawing. */
export function createLayoutClipboardPayload(state: LayoutDocumentState, page: LayoutPage, entities: LayoutEntity[]): LayoutClipboardPayload {
  const native = JSON.stringify({ version: 1, entities });
  // Preserve existing non-path copy behavior; a mixed selection's native payload includes every object.
  const paths = new Set(entities.filter(entity => entity.kind === 'path').map(entity => entity.id));
  const svg = paths.size ? writeLayoutSvg(drawLayoutVectorPage(state, page, { entityIds: paths }), 'drawing') : '';
  const text = entities.flatMap(entity => entity.text ? [entity.text.content] : []).join('\n') || svg;
  // Standard HTML survives clipboard transport where custom web formats are unavailable.
  // It is parsed as inert clipboard data, never inserted into the application's DOM.
  const html = `<div data-pushform-layout="${encodeURIComponent(native)}">${svg || text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div>`;
  return { native, svg, html, text };
}

/** Synchronous formats preserve in-app copy even if native SVG clipboard access is denied. */
export function writeLayoutClipboardEvent(data: DataTransfer, payload: LayoutClipboardPayload): void {
  data.setData(LAYOUT_CLIPBOARD_TYPE, payload.native);
  data.setData('text/plain', payload.text);
  data.setData('text/html', payload.html);
  if (payload.svg) data.setData('image/svg+xml', payload.svg);
}

/** Return a completion only when the platform can publish native SVG, not a web-custom SVG type. */
export function writeLayoutSystemClipboard(payload: LayoutClipboardPayload): Promise<void> | null {
  if (!payload.svg) return null;
  // The copy event's default clipboard commit happens after its listeners. Publish
  // native formats in the next task so that commit cannot overwrite the SVG.
  const afterEvent = (write: () => Promise<void>): Promise<void> => new Promise((resolve, reject) => {
    setTimeout(() => { void Promise.resolve().then(write).then(resolve, reject); }, 0);
  });
  if (isTauri()) return afterEvent(() => invoke<void>('layout_clipboard_write', { payload }));
  if (typeof ClipboardItem === 'undefined' || !ClipboardItem.supports?.('image/svg+xml') || !navigator.clipboard?.write) return null;
  return afterEvent(() => navigator.clipboard.write([new ClipboardItem({
    'image/svg+xml': new Blob([payload.svg], { type: 'image/svg+xml' }),
    'text/html': new Blob([payload.html], { type: 'text/html' }),
    'text/plain': new Blob([payload.text], { type: 'text/plain' }),
  })]));
}

export function readLayoutSystemClipboard(): Promise<Record<string, string>> | null {
  if (isTauri()) return invoke<Record<string, string>>('layout_clipboard_read');
  if (!navigator.clipboard?.read) return null;
  // Paste events can expose only a raster preview even when the native clipboard has SVG.
  // Read during the user's paste gesture, then keep the event snapshot if access is denied.
  return navigator.clipboard.read().then(async items => {
    for (const item of items) if (item.types.includes('image/svg+xml')) {
      return { 'image/svg+xml': await (await item.getType('image/svg+xml')).text() };
    }
    return {};
  }).catch(() => ({}));
}
