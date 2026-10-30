// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { zipSync, strToU8, type Zippable } from 'fflate';
import { entitiesForLayer, type LayoutDocumentState } from '@pushform/layout';
import { writeLayoutDxf, writeLayoutSvg, type LayoutExportArea } from '@pushform/io';
import { drawLayoutVectorPage } from './layoutVectorDrawing';
import { prepareLayoutFonts } from './layoutFonts';
import { prepareLayoutPages } from './layoutPrint';
import { layoutImageExportName, safeLayoutExportName, type LayoutImageExportFile } from './layoutImageExport';

export interface LayoutVectorExportOptions { format: 'svg' | 'dxf'; area: LayoutExportArea; scale: number }
export interface LayoutVectorExportFile extends LayoutImageExportFile { warnings: string[] }

/** Record the same content painters used by print, retaining paths and text as vectors. */
export async function exportLayoutVectors(state: LayoutDocumentState, pageIds: readonly number[], documentName: string,
  options: LayoutVectorExportOptions, signal?: AbortSignal): Promise<LayoutVectorExportFile | null> {
  if (!pageIds.length) throw new Error('Choose at least one page to export.');
  for (const id of pageIds) if (!state.pages.has(id)) throw new Error('A selected page is no longer available.');
  // DXF omits pictures, so broken or pending pictures must not prevent CAD export.
  if (options.format === 'svg') await prepareLayoutPages(state, pageIds);
  else {
    await prepareLayoutFonts(pageIds.flatMap(id => state.layerOrder.flatMap(layer => entitiesForLayer(state.pages.get(id)!, state, layer))));
  }
  if (signal?.aborted) return null;
  const files: Uint8Array[] = [], warnings = new Set<string>();
  for (const id of pageIds) {
    const page = drawLayoutVectorPage(state, state.pages.get(id)!, { includeImages: options.format === 'svg', editableTextBlocks: options.format === 'svg' });
    if (options.format === 'svg') files.push(strToU8(writeLayoutSvg(page, options.area)));
    else {
      const result = writeLayoutDxf(page, options.area, options.scale);
      files.push(strToU8(result.text)); result.warnings.forEach(warning => warnings.add(warning));
    }
    if (signal?.aborted) return null;
  }
  const name = layoutImageExportName(documentName, state, pageIds, options.format);
  if (files.length === 1) return { bytes: files[0]!, name, extension: options.format,
    mime: options.format === 'svg' ? 'image/svg+xml' : 'application/dxf', warnings: [...warnings] };
  const entries: Zippable = {}, digits = String(pageIds.length).length;
  pageIds.forEach((id, index) => {
    entries[`${String(index + 1).padStart(digits, '0')} ${safeLayoutExportName(state.pages.get(id)!.name)}.${options.format}`] = files[index]!;
  });
  return { bytes: zipSync(entries), name, extension: 'zip', mime: 'application/zip', warnings: [...warnings] };
}
