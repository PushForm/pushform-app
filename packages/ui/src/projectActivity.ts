// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ProjectActivityEvent, ProjectActivityKind, ProjectActivitySink } from '@pushform/cloud';
import type { ChangeEvent, DocumentState } from '@pushform/model';
import type { LayoutDocumentState } from '@pushform/layout';
import { modelContentIdentity, layoutContentIdentity } from '@pushform/io';
import type { DocumentTab } from './session';
import { cloudLocation } from './cloudDocuments';

export function authoredChange(event: ChangeEvent, type: 'model' | 'layout'): boolean {
  if (event.source === 'load') return false;
  return event.patches.some(p => type === 'model'
    ? p.path[0] === 'definitions' && (p.path.length === 2 || p.path.includes('entities')) || ['materials','images','tags','tagFolders'].includes(String(p.path[0]))
    : ['pages','sharedEntities','references','layers'].includes(String(p.path[0])));
}
export function hasDesign(state: DocumentState | LayoutDocumentState, type: 'model' | 'layout'): boolean {
  if (type === 'model') { const model = state as DocumentState; return (model.definitions.get(model.rootDefinitionId)?.entities.order.length ?? 0) > 0; }
  const layout = state as LayoutDocumentState;
  return layout.sharedEntities.size > 0 || [...layout.pages.values()].some(p => p.entities.size > 0);
}
export function stateOf(tab: DocumentTab): DocumentState | LayoutDocumentState { return tab.type === 'model' ? tab.app.document.doc.state : tab.doc.state; }
export function fingerprint(state: DocumentState | LayoutDocumentState, type: 'model' | 'layout'): string {
  return (type === 'model' ? modelContentIdentity(state as DocumentState) : layoutContentIdentity(state as LayoutDocumentState)).split(':').at(-1)!;
}
export class SessionProjectActivity {
  private baselines = new Map<string, string>();
  private started = new Set<string>();
  private saved = new Set<string>();
  private lastAt = 0;
  constructor(private sink?: ProjectActivitySink) {}
  private enabled(): boolean { try { return this.sink?.enabled() ?? false; } catch { return false; } }
  private send(tab: DocumentTab, kind: ProjectActivityKind, storage: 'local' | 'cloud', hash?: string, state = stateOf(tab)): void {
    if (!this.enabled() || tab.placeholder) return;
    const location = storage === 'cloud' ? cloudLocation(tab.identity) : null;
    if (storage === 'cloud' && !location) return;
    const at = Math.max(Date.now(), this.lastAt + 1); this.lastAt = at;
    const event: ProjectActivityEvent = { id: crypto.randomUUID(), kind, documentKey: state.meta.guid, fingerprint: hash ?? fingerprint(state, tab.type),
      documentType: tab.type, storage, at: new Date(at).toISOString(), ...(location ? { fileId: location.fileId, revisionId: location.revisionId } : {}) };
    try { this.sink?.record(event); } catch { /* Optional measurement never interrupts a document operation. */ }
  }
  watch(tab: DocumentTab): void {
    // The saved key is already computed by session creation/opening. Converted imports use their current state.
    this.baselines.set(tab.id, tab.savedContent.split(':').at(-1) || (this.enabled() ? fingerprint(stateOf(tab), tab.type) : ''));
  }
  changed(tab: DocumentTab, change: ChangeEvent): void {
    if (!this.enabled() || tab.placeholder || !authoredChange(change, tab.type) || !hasDesign(stateOf(tab), tab.type)) return;
    const hash = fingerprint(stateOf(tab), tab.type);
    if (hash === this.baselines.get(tab.id)) return;
    if (!this.started.has(tab.id)) { this.send(tab, 'project_started', 'local'); this.started.add(tab.id); }
    this.send(tab, 'meaningful_edit', 'local', hash);
    // The same authored state can later be saved to either store. Bind cloud edits to their owned file/revision.
    if (cloudLocation(tab.identity)) this.send(tab, 'meaningful_edit', 'cloud', hash);
  }
  opened(tab: DocumentTab, storage: 'local' | 'cloud', imported = false): void {
    if (!this.enabled() || !hasDesign(stateOf(tab), tab.type)) return;
    if (imported && !this.started.has(tab.id)) { this.send(tab, 'project_started', 'local'); this.started.add(tab.id); }
    this.send(tab, 'reopen_succeeded', storage);
  }
  savedSnapshot(tab: DocumentTab, state: DocumentState | LayoutDocumentState): void {
    if (!this.enabled() || !hasDesign(state, tab.type)) return;
    const hash = fingerprint(state, tab.type), key = `${state.meta.guid}:${hash}:local`;
    if (this.saved.has(key)) return;
    this.saved.add(key); this.send(tab, 'save_succeeded', 'local', hash, state);
  }
  cloudSaved(tab: DocumentTab, savedContent: string): void { this.send(tab, 'save_succeeded', 'cloud', savedContent.split(':').at(-1)); }
  closed(tab: DocumentTab): void {
    if (!this.enabled() || !hasDesign(stateOf(tab), tab.type)) return;
    this.send(tab, 'document_closed', 'local');
    if (cloudLocation(tab.identity)) this.send(tab, 'document_closed', 'cloud');
  }
}
