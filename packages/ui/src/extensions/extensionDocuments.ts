// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { commandsDocument, documentUnitsOf, type ExtensionDocument, type ExtensionDocuments } from '@pushform/extensions';
import { displayDocumentName } from '../documentName';
import type { DocumentSession, DocumentTab } from '../session';
import { unitsFor } from './useExtensionWorkspace';

/**
 * The open tabs as extensions reach them, by tab id: a model tab's model operations, selection, name and units, and
 * a Layout document's name and units. The name is the tab's title, and the units are the ones extension panels show
 * quantities in, so what an extension names or formats itself matches what PushForm shows for it.
 */
export function sessionExtensionDocuments(session: () => DocumentSession | null): ExtensionDocuments {
  const documents = new WeakMap<DocumentTab, ExtensionDocument>();
  return {
    get(documentId) {
      const tab = session()?.tabs.find((t) => t.id === documentId);
      if (!tab) return null;
      let document = documents.get(tab);
      if (!document) documents.set(tab, document = tabDocument(tab, session));
      return document;
    },
  };
}

/** A tab's document, which reports its renames: the session, not the document, announces them. */
function tabDocument(tab: DocumentTab, session: () => DocumentSession | null): ExtensionDocument {
  const name = () => displayDocumentName(tab);
  const document = tab.type === 'model' ? commandsDocument(tab.app.commands, name) : layoutDocument(tab, name);
  return {
    ...document,
    listen(listener) {
      const offDocument = document.listen(listener);
      let shown = name();
      const offSession = session()?.subscribe(() => {
        const now = name();
        if (now !== shown) { shown = now; listener('name'); }
      });
      return () => { offDocument(); offSession?.(); };
    },
  };
}

function layoutDocument(tab: DocumentTab & { type: 'layout' }, name: () => string): ExtensionDocument {
  const units = () => documentUnitsOf(unitsFor(tab));
  return {
    name,
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
