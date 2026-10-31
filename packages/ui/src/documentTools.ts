// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { guidanceFor } from './guidance';
import { LAYOUT_API_VERSION, LAYOUT_TOOLS, MODEL_API_VERSION, MODEL_TOOLS, type LayoutApiError } from '@pushform/extension-protocol';
import { LayoutDocumentApi, ModelDocumentApi, runLayoutTool, runModelTool } from '@pushform/extensions';
import type { DocumentToolOutcome, DocumentToolSession } from '@pushform/requests-ui';
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

/** Every applied batch leaves a line in the chat naming its undo entry. */
function withNotice(result: DocumentToolOutcome): DocumentToolOutcome {
  const label = String((JSON.parse(result.content) as { label?: unknown }).label ?? '').slice(CLIENT.length + 2);
  return { ...result, notice: `Changed the document: ${label}. Undo reverts it.` };
}

/**
 * AI Chat's view of one tab's document: the Layout document API for a Layout tab, the model document API for a
 * model tab. Each document's conversation edits only its own tab, and only while that tab is active.
 * A call that arrives after the tab was closed or another tab was brought forward changes nothing and reports why.
 */
export function documentToolsFor(session: DocumentSession, tab: DocumentTab, openPanel?: (panel: 'objects' | 'requests') => void): DocumentToolSession | null {
  const guidance = openPanel ? guidanceFor(session, tab, openPanel) : null;
  if (tab.type === 'model') {
    const api = new ModelDocumentApi(tab.app.commands, CLIENT);
    return {
      document: { type: 'model', apiVersion: MODEL_API_VERSION, edit: 1, ...(guidance ? { guidance: 1 as const } : {}) },
      progress: call => (call.name === MODEL_TOOLS.applyOperations.name ? 'Applying the change…' : call.name === MODEL_TOOLS.view.name ? 'Changing the view…' : undefined),
      run: async (call, signal) => {
        if (guidance && call.name.startsWith('ui_')) return guidance(call.name, call.input, signal, call.id);
        const refused = gone(session, tab, api.revision);
        if (refused) return refused;
        const result = await runModelTool(api, call.name, call.input, signal);
        return result.isError || call.name !== MODEL_TOOLS.applyOperations.name ? result : withNotice(result);
      },
    };
  }
  const api = new LayoutDocumentApi(tab.doc, tab.commands, {
    activePageId: () => tab.activePageId,
    selectedEntityIds: () => (tab.workspace.selectedEntityId === null ? [] : [tab.workspace.selectedEntityId]),
  }, CLIENT);
  return {
    document: { type: 'layout', apiVersion: LAYOUT_API_VERSION, ...(guidance ? { guidance: 1 as const } : {}) },
    run: (call, signal) => {
      if (guidance && call.name.startsWith('ui_')) return guidance(call.name, call.input, signal, call.id);
      const refused = gone(session, tab, api.revision);
      if (refused) return refused;
      const result = runLayoutTool(api, call.name, call.input);
      return result.isError || call.name !== LAYOUT_TOOLS.applyOperations.name ? result : withNotice(result);
    },
  };
}
