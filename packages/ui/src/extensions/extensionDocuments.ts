// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { commandsDocument, documentUnitsOf, type ExtensionDocument, type ExtensionDocuments } from '@pushform/extensions';
import type { DocumentSession, DocumentTab } from '../session';
import { unitsFor } from './useExtensionWorkspace';

/**
 * The open tabs as extensions reach them, by tab id: a model tab's model operations, selection and units, and a
 * Layout document's units. The units are the ones extension panels show quantities in, so what an extension formats
 * itself matches what PushForm formats for it.
 */
export function sessionExtensionDocuments(session: () => DocumentSession | null): ExtensionDocuments {
  const documents = new WeakMap<DocumentTab, ExtensionDocument>();
  return {
    get(documentId) {
      const tab = session()?.tabs.find((t) => t.id === documentId);
      if (!tab) return null;
      let document = documents.get(tab);
      if (!document) documents.set(tab, document = tabDocument(tab));
      return document;
    },
  };
}

function tabDocument(tab: DocumentTab): ExtensionDocument {
  if (tab.type === 'model') return commandsDocument(tab.app.commands);
  const units = () => documentUnitsOf(unitsFor(tab));
  return {
    units,
    model: () => null,
    listen(listener) {
      let shown = JSON.stringify(units());
      return tab.doc.events.on('change', () => {
        const now = JSON.stringify(units());
        if (now !== shown) { shown = now; listener('units'); }
      });
    },
  };
}
