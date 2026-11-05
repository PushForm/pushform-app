// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { commonsFileUrl, type CatalogModel, type CommonsFile } from '@pushform/cloud';
import { isPreviewModelFile } from '@pushform/cloud/preview';

const formats = ['pf', 'step', 'stp', 'stl', 'glb', 'gltf', 'obj', 'dae', '3ds', 'skp', 'skb', 'dxf', 'kmz', 'zip', 'fcstd'];
/** Keep native and commonly exchanged models ahead of archives and authoring sources. */
export function sortedModelFiles(files: readonly CommonsFile[]): CommonsFile[] {
  const rank = (name: string) => { const index = formats.indexOf(name.split('.').at(-1)?.toLowerCase() ?? ''); return index < 0 ? formats.length : index; };
  return [...files].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
export function commonsPreviewFile(model: CatalogModel): CommonsFile | undefined {
  const files = sortedModelFiles(model.files).filter(file => isPreviewModelFile(file.name));
  return files.find(file => !/\.zip$/i.test(file.name)) ?? files[0];
}
export function commonsImageSources(model: CatalogModel, filesUrl?: string): string[] {
  const geometry = commonsPreviewFile(model);
  return [...new Set([model.previewImage ? commonsFileUrl(filesUrl, 'images', model.previewImage.id) : null,
    model.imageUrl, geometry ? commonsFileUrl(filesUrl, 'thumbnails', geometry.id) : null].filter((url): url is string => Boolean(url)))];
}
