// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect } from 'react';
import { clipboardExtentPoints, modelClipboard, SERVICE_MODEL_SOURCE, type CameraState, type ModelClipboard, type ModelClipboardSource } from '@pushform/commands';
import type { Box3, ImageId, Vec3 } from '@pushform/core';
import { decodeModelSessionJson, modelSessionJson } from '@pushform/io';
import { base64ToBytes, bytesToBase64, type ImageBlob } from '@pushform/model';
import type { AppInstance } from './bootstrap';
import { cloudLocation } from './cloudDocuments';
import type { ModelTab } from './session';

/** Clipboard type of a Modeling copy, beside Layout's `application/x-pushform-layout`. */
export const MODEL_CLIPBOARD_TYPE = 'application/x-pushform-model';

interface ModelClipboardJson {
  version: 1;
  id: string;
  /** The clipboard model as a session snapshot. */
  state: string;
  images: { id: number; mime: string; data: string }[];
  bounds: Box3;
  insertionPoint: Vec3;
  camera: CameraState | null;
  source: ModelClipboardSource | null;
  skipped: number;
  /** Corners of the copied entities in world coordinates, which a Layout view of the copy frames. */
  extent: Vec3[];
}

/** What Layout needs to show a Modeling copy as a model view. */
export interface ModelClipboardView {
  readonly source: ModelClipboardSource | null;
  readonly camera: CameraState | null;
  readonly extent: readonly Vec3[];
}

export function encodeModelClipboard(clip: ModelClipboard): string {
  const json: ModelClipboardJson = {
    version: 1, id: clip.id, state: modelSessionJson(clip.state),
    images: [...clip.images].map(([id, blob]) => ({ id, mime: blob.mime, data: bytesToBase64(blob.bytes) })),
    bounds: clip.bounds, insertionPoint: clip.insertionPoint, camera: clip.camera, source: clip.source, skipped: clip.skipped,
    extent: clipboardExtentPoints(clip),
  };
  return JSON.stringify(json);
}

function parse(text: string): ModelClipboardJson {
  const json = JSON.parse(text) as ModelClipboardJson;
  if (json?.version !== 1 || typeof json.state !== 'string' || typeof json.id !== 'string') throw new Error('Unsupported model clipboard data');
  return json;
}

export function decodeModelClipboard(text: string): ModelClipboard {
  const json = parse(text);
  const images = new Map<ImageId, ImageBlob>(json.images.map(image => [image.id as ImageId, { mime: image.mime, bytes: base64ToBytes(image.data) }]));
  return { id: json.id, state: decodeModelSessionJson(json.state), images, bounds: json.bounds, insertionPoint: json.insertionPoint,
    camera: json.camera, source: json.source, skipped: json.skipped };
}

/** The Layout view data of the model copy on the clipboard, or null when it holds none. */
export function readModelClipboardView(data: DataTransfer): ModelClipboardView | null {
  const text = data.getData(MODEL_CLIPBOARD_TYPE);
  if (text) {
    const json = parse(text);
    return { source: json.source, camera: json.camera, extent: json.extent };
  }
  return null;
}

/** Id of the last copy written to the system clipboard; anything copied since replaced it there. */
let sentId: string | null = null;

/**
 * This window's copy when it never reached the system clipboard (copied from command search or a
 * menu); a copy that did is pasted from there, so newer clipboard content is not shadowed by it.
 */
export function unsentModelClipboard(): ModelClipboard | null {
  const clip = modelClipboard.current;
  return clip && clip.id !== sentId ? clip : null;
}

/** The view data of this window's unsent copy (`unsentModelClipboard`). */
export function currentModelClipboardView(): ModelClipboardView | null {
  const clip = unsentModelClipboard();
  return clip ? { source: clip.source, camera: clip.camera, extent: clipboardExtentPoints(clip) } : null;
}

const editingText = (event: ClipboardEvent): boolean => event.defaultPrevented ||
  event.target instanceof Element && Boolean(event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'));

/**
 * Cut, copy and paste of the active model tab through the system clipboard: copies are
 * written beside this window's shared clipboard, and a paste takes another window's copy first.
 */
export function useModelClipboard(app: AppInstance, tab: ModelTab | null, enabled: boolean): void {
  useEffect(() => {
    if (!tab) return;
    const services = app.commands.ctx.services;
    const source = (): ModelClipboardSource | null => {
      const location = cloudLocation(tab.identity);
      return location ? { documentId: location.fileId, name: tab.name } : null;
    };
    services.set(SERVICE_MODEL_SOURCE, source);
    return () => { if (services.get(SERVICE_MODEL_SOURCE) === source) services.delete(SERVICE_MODEL_SOURCE); };
  }, [app, tab]);

  useEffect(() => {
    if (!enabled) return;
    const copy = (event: ClipboardEvent, command: 'edit.copy' | 'edit.cut'): void => {
      if (editingText(event) || !app.commands.isEnabled(command)) return;
      event.preventDefault();
      if (!app.commands.tryExecute(command).ok) return;
      const clip = modelClipboard.current;
      if (clip && event.clipboardData) {
        event.clipboardData.setData(MODEL_CLIPBOARD_TYPE, encodeModelClipboard(clip));
        sentId = clip.id;
      }
    };
    const onCopy = (event: ClipboardEvent): void => copy(event, 'edit.copy');
    const onCut = (event: ClipboardEvent): void => copy(event, 'edit.cut');
    const onPaste = (event: ClipboardEvent): void => {
      if (editingText(event)) return;
      const text = event.clipboardData?.getData(MODEL_CLIPBOARD_TYPE);
      if (text) {
        try {
          const id = (JSON.parse(text) as { id?: unknown }).id;
          if (id !== modelClipboard.current?.id) modelClipboard.set(decodeModelClipboard(text));
          sentId = modelClipboard.current?.id ?? null;
        } catch { return; }
      } else if (!unsentModelClipboard()) return;
      event.preventDefault();
      app.commands.tryExecute('edit.paste');
    };
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCut);
      window.removeEventListener('paste', onPaste);
    };
  }, [app, enabled]);
}
