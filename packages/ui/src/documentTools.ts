// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { guidanceFor } from './guidance';
import { LAYOUT_API_VERSION, LAYOUT_TOOLS, MODEL_API_VERSION, MODEL_TOOLS, type LayoutApiError } from '@pushform/extension-protocol';
import { LayoutDocumentApi, ModelDocumentApi, runLayoutTool, runModelTool, type ModelRenderer } from '@pushform/extensions';
import type { Viewport } from '@pushform/render';
import { TOOL_IMAGE_MAX_CHARS, type ClonedDocument, type CloneRequest, type DocumentToolOutcome, type DocumentToolSession } from '@pushform/requests-ui';
import type { DocumentSession, DocumentTab } from './session';

/** Names the chat's undo entries. */
const CLIENT = 'AI Chat';

const unavailable = (message: string, revision: number): DocumentToolOutcome => {
  const error: LayoutApiError = { code: 'unavailable', message, revision };
  return { content: JSON.stringify({ ok: false, error }), isError: true };
};

/** Why a call bound to `tab` may not touch it any more, or null while the tab is open and active. */
function gone(session: DocumentSession, tab: DocumentTab, revision: number): DocumentToolOutcome | null {
  if (!session.tabs.includes(tab)) return unavailable(`The document "${tab.name}" was closed; nothing was changed.`, revision);
  if (session.active !== tab) return unavailable(`The requester switched away from "${tab.name}"; nothing was changed. Ask them to return to it and try again.`, revision);
  return null;
}

/** JPEG qualities tried in turn until a picture fits the tool result's size limit. */
const RENDER_QUALITIES = [0.85, 0.7, 0.5];

/** Base64 of bytes, in chunks small enough for String.fromCharCode. */
function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Pictures drawn by the tab's own viewport into a canvas of their own, as cloud thumbnails are: the snapshot puts the
 * viewport's camera and size back before returning, so the requester's view never moves. The model keeps its own
 * style (edges, faces, textures) on the style's background; without a renderer (headless, a parked tab) it answers null.
 */
export function viewportRenderer(viewport: Viewport): ModelRenderer {
  return async (camera, width, height) => {
    if (typeof document === 'undefined') return null;
    // A texture that cannot load is drawn without it rather than failing the review.
    await viewport.sceneSync.textures.whenReady().catch(() => {});
    const picture = document.createElement('canvas');
    const background = `#${viewport.sceneSync.backgroundColor().toString(16).padStart(6, '0')}`;
    if (!viewport.snapshotInto(picture, width, height, camera, { background })) return null;
    for (const quality of RENDER_QUALITIES) {
      const blob = await new Promise<Blob | null>(resolve => picture.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) return null;
      const data = base64Of(new Uint8Array(await blob.arrayBuffer()));
      if (data.length <= TOOL_IMAGE_MAX_CHARS) return { mime: 'image/jpeg', data };
    }
    return null;
  };
}

/**
 * The chat's one line about everything the message's batches changed so far. The chat shows it once per message and
 * updates it in place, so a change made in several batches still reads as one change with one undo step.
 */
function changeNotice(changes: { label: string; undoSteps: number } | null): string | undefined {
  if (!changes) return undefined;
  const undo = changes.undoSteps > 1 ? `Undo reverts it in ${changes.undoSteps} steps.` : 'Undo reverts it.';
  return `Changed the document: ${changes.label}. ${undo}`;
}

function withNotice(result: DocumentToolOutcome, api: { readonly changes: { label: string; undoSteps: number } | null }): DocumentToolOutcome {
  const notice = changeNotice(api.changes);
  return notice ? { ...result, notice } : result;
}

/**
 * AI Chat's view of one tab's document: the Layout document API for a Layout tab, the model document API for a
 * model tab. Each document's conversation edits only its own tab, and only while that tab is active.
 * A call that arrives after the tab was closed or another tab was brought forward changes nothing and reports why.
 * `clone` makes a confirmed clone of the tab's document; without it the chat offers no cloning.
 */
export function documentToolsFor(session: DocumentSession, tab: DocumentTab, openPanel?: (panel: 'objects' | 'requests') => void,
  clone?: (tab: DocumentTab, request: CloneRequest) => Promise<ClonedDocument>): DocumentToolSession | null {
  const guidance = openPanel ? guidanceFor(session, tab, openPanel) : null;
  const cloning = clone ? {
    name: tab.name.replace(/\.(pfl?)$/i, ''),
    clone: async (request: CloneRequest): Promise<ClonedDocument> => {
      if (!session.tabs.includes(tab)) throw new Error(`The document "${tab.name}" was closed.`);
      return clone(tab, request);
    },
  } : {};
  if (tab.type === 'model') {
    const api = new ModelDocumentApi(tab.app.commands, CLIENT);
    const renderer = viewportRenderer(tab.app.viewport);
    return {
      document: { type: 'model', apiVersion: MODEL_API_VERSION, edit: 1, ...(guidance ? { guidance: 1 as const } : {}), ...(clone ? { clone: 1 as const } : {}) },
      ...cloning,
      progress: call => (call.name === MODEL_TOOLS.applyOperations.name ? 'Applying the change…' : call.name === MODEL_TOOLS.view.name ? 'Changing the view…'
        : call.name === MODEL_TOOLS.render.name ? 'Checking the result…' : undefined),
      run: async (call, signal) => {
        if (guidance && call.name.startsWith('ui_')) return guidance(call.name, call.input, signal, call.id);
        const refused = gone(session, tab, api.revision);
        if (refused) return refused;
        const result = await runModelTool(api, call.name, call.input, signal, { renderer });
        if (call.name === MODEL_TOOLS.render.name) {
          if (result.isError || !result.images?.length) return { content: result.content, isError: result.isError };
          const views = (JSON.parse(result.content) as { views: { name: string }[] }).views.map(view => view.name);
          return { content: result.content, isError: false, images: result.images, views };
        }
        return result.isError || call.name !== MODEL_TOOLS.applyOperations.name ? result : withNotice(result, api);
      },
    };
  }
  const api = new LayoutDocumentApi(tab.doc, tab.commands, {
    activePageId: () => tab.activePageId,
    selectedEntityIds: () => (tab.workspace.selectedEntityId === null ? [] : [tab.workspace.selectedEntityId]),
  }, CLIENT);
  return {
    document: { type: 'layout', apiVersion: LAYOUT_API_VERSION, ...(guidance ? { guidance: 1 as const } : {}), ...(clone ? { clone: 1 as const } : {}) },
    ...cloning,
    run: (call, signal) => {
      if (guidance && call.name.startsWith('ui_')) return guidance(call.name, call.input, signal, call.id);
      const refused = gone(session, tab, api.revision);
      if (refused) return refused;
      const result = runLayoutTool(api, call.name, call.input);
      return result.isError || call.name !== LAYOUT_TOOLS.applyOperations.name ? result : withNotice(result, api);
    },
  };
}
