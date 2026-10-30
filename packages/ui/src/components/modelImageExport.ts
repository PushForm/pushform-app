// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ImageOptions } from '@pushform/render';

export type ModelImageFormat = 'png' | 'jpeg';
/** The 2D graphic export options. */
export interface ModelImageChoice {
  format: ModelImageFormat;
  useViewSize: boolean;
  /** The custom size, used when `useViewSize` is off. */
  width: number;
  height: number;
  antialias: boolean;
  /** PNG only. */
  transparent: boolean;
}
/** Largest picture exported: browsers refuse or fail canvases much bigger than this (as). */
export const MAX_MODEL_IMAGE_SIDE = 16384, MAX_MODEL_IMAGE_PIXELS = 100_000_000;
const JPEG_QUALITY = 0.92;

/** Draws the view into a canvas of the given size (`Viewport.renderImage`); null when it cannot. */
export type ModelImageRenderer = (width: number, height: number, options: ImageOptions) => HTMLCanvasElement | null;

/** The picture's size in pixels: the view's, or the custom size. */
export function modelImageSize(choice: Pick<ModelImageChoice, 'useViewSize' | 'width' | 'height'>, view: { width: number; height: number }): [number, number] {
  return choice.useViewSize ? [Math.max(1, Math.round(view.width)), Math.max(1, Math.round(view.height))]
    : [Math.max(1, Math.round(choice.width)), Math.max(1, Math.round(choice.height))];
}

/** The other side of a custom size, kept in the view's proportions. */
export function keepProportions(side: 'width' | 'height', value: number, view: { width: number; height: number }): number {
  const aspect = Math.max(1, view.width) / Math.max(1, view.height);
  return Math.max(1, Math.round(side === 'width' ? value / aspect : value * aspect));
}

/** Why a picture of this size cannot be exported, or null. */
export function modelImageSizeError(width: number, height: number): string | null {
  return width > MAX_MODEL_IMAGE_SIDE || height > MAX_MODEL_IMAGE_SIDE || width * height > MAX_MODEL_IMAGE_PIXELS
    ? `A picture of ${width} × ${height} pixels is too large to export. Choose a smaller size.` : null;
}

/** A name that every file system accepts, from the model's name, with the format's extension. */
export function modelImageFileName(modelName: string, format: ModelImageFormat): string {
  const base = [...modelName.replace(/\.(pf|skp)$/i, '')].map(c => c < ' ' || '\\/:*?"<>|'.includes(c) ? '-' : c).join('').trim() || 'Untitled';
  return `${base}.${format === 'png' ? 'png' : 'jpg'}`;
}

/** Draw the view at the chosen size and encode it as PNG or JPEG. Throws a readable error when it cannot. */
export async function renderModelImage(render: ModelImageRenderer, choice: ModelImageChoice, view: { width: number; height: number }): Promise<Uint8Array> {
  const [width, height] = modelImageSize(choice, view);
  const tooLarge = modelImageSizeError(width, height);
  if (tooLarge) throw new Error(tooLarge);
  const canvas = render(width, height, { antialias: choice.antialias, transparent: choice.format === 'png' && choice.transparent });
  const failed = `A picture of ${width} × ${height} pixels could not be drawn. Choose a smaller size.`;
  if (!canvas) throw new Error(failed);
  const mime = choice.format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, JPEG_QUALITY));
  if (!blob) throw new Error(failed);
  return new Uint8Array(await blob.arrayBuffer());
}
