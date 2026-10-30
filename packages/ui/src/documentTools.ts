// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { guidanceFor } from './guidance';
import { LAYOUT_API_VERSION, LAYOUT_TOOLS, type LayoutApiError } from '@pushform/extension-protocol';
import { LayoutDocumentApi, runLayoutTool } from '@pushform/extensions';
import type { DocumentToolOutcome, DocumentToolSession } from '@pushform/requests-ui';
import type { DocumentSession, DocumentTab } from './session';

/** Names the chat's undo entries. */
const CLIENT = 'AI Chat';

const unavailable = (message: string, revision: number): DocumentToolOutcome => {
  const error: LayoutApiError = { code: 'unavailable', message, revision };
  return { content: JSON.stringify({ ok: false, error }), isError: true };
};

/**
 * AI Chat's view of one tab's document: Layout documents only for now, a model tab offers no document
 * tools. Each document's conversation edits only its own tab, and only while that tab is active
 * A call that arrives after the tab was closed or another tab was brought forward changes nothing and reports why.
 */
export function documentToolsFor(session: DocumentSession, tab: DocumentTab, openPanel?: (panel: 'objects' | 'requests') => void): DocumentToolSession | null {
  const guidance = openPanel ? guidanceFor(session, tab, openPanel) : null;
  if (tab.type !== 'layout') return guidance ? { document: { type: 'model', apiVersion: 1, guidance: 1 }, run: (call, signal) => guidance(call.name, call.input, signal, call.id) } : null;
  const api = new LayoutDocumentApi(tab.doc, tab.commands, {
    activePageId: () => tab.activePageId,
    selectedEntityIds: () => (tab.workspace.selectedEntityId === null ? [] : [tab.workspace.selectedEntityId]),
  }, CLIENT);
  return {
    document: { type: 'layout', apiVersion: LAYOUT_API_VERSION, ...(guidance ? { guidance: 1 as const } : {}) },
    run: (call, signal) => {
      if (guidance && call.name.startsWith('ui_')) return guidance(call.name, call.input, signal, call.id);
      if (!session.tabs.includes(tab)) return unavailable(`The document "${tab.name}" was closed; nothing was changed.`, api.revision);
      if (session.active !== tab) return unavailable(`The requester switched away from "${tab.name}"; nothing was changed. Ask them to return to it and try again.`, api.revision);
      const result = runLayoutTool(api, call.name, call.input);
      if (result.isError || call.name !== LAYOUT_TOOLS.applyOperations.name) return result;
      // Every applied batch leaves a line in the chat naming its undo entry.
      const label = String((JSON.parse(result.content) as { label?: unknown }).label ?? '').slice(CLIENT.length + 2);
      return { ...result, notice: `Changed the document: ${label}. Undo reverts it.` };
    },
  };
}
