// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
import type { CloudSavedFile } from '@pushform/cloud';
import { isCloudSource, type CloudModelReference, type LayoutDocumentState } from '@pushform/layout';
import type { LayoutCloudAccess, LayoutReferenceStatus } from './layoutCloudModels';
import type { LayoutViewportSource } from './layoutViewportRenders';

/**
 * The drawing's model sources: each cloud reference with its revision, freshness and
 * pin state, and each embedded SketchUp model with the option to make it editable.
 */
export function LayoutReferencesPanel({ state, sources, statuses, cloud, onUpdate, onPin, onEdit, onConvert }: {
  state: LayoutDocumentState;
  sources: readonly LayoutViewportSource[];
  statuses: ReadonlyMap<number, LayoutReferenceStatus>;
  cloud: LayoutCloudAccess | undefined;
  onUpdate: (referenceId: number, head: CloudSavedFile) => void;
  onPin: (referenceId: number, pinned: boolean) => void;
  onEdit: (reference: CloudModelReference) => void;
  onConvert: (source: { archiveId: string; modelReferenceId: string }, name: string) => void;
}): JSX.Element {
  // The panel's Models section supplies the heading; this is its content.
  return <div className="pf-layout-references" role="region" aria-label="Model references">
    <ul>
      {sources.map(source => {
        if (isCloudSource(source.source)) {
          const reference = state.references.get(source.source.referenceId) as CloudModelReference | undefined;
          if (!reference) return null;
          // A pinned reference that was updated to the reported head is current until the next check.
          const checked = statuses.get(reference.id);
          const status = checked?.kind === 'outdated' && checked.head.revision.id === reference.target.revisionId ? { kind: 'current' as const } : checked;
          const label = !cloud ? 'Sign in to check for changes' : !status || status.kind === 'checking' ? 'Checking…'
            : status.kind === 'current' ? (reference.target.pinned ? 'Pinned' : 'Current') : status.kind === 'outdated' ? `Pinned; revision ${status.head.file.revision_number} available` : status.reason;
          return <li key={source.key}>
            <span><strong>{reference.displayName}</strong><small>Cloud model, revision {reference.target.revisionNumber}. {label}</small></span>
            <span className="pf-layout-reference-actions">
              {status?.kind === 'outdated' ? <button type="button" onClick={() => onUpdate(reference.id, status.head)}>Update</button> : null}
              <button type="button" aria-pressed={reference.target.pinned} onClick={() => onPin(reference.id, !reference.target.pinned)}>{reference.target.pinned ? 'Unpin' : 'Pin'}</button>
              <button type="button" disabled={!cloud} onClick={() => onEdit(reference)}>Edit model</button>
            </span>
          </li>;
        }
        const embedded = source.source;
        return <li key={source.key}>
          <span><strong>{source.name}</strong><small>Embedded SketchUp model. Views export to LayOut as model viewports.</small></span>
          <span className="pf-layout-reference-actions">
            <button type="button" disabled={!cloud} title={cloud ? 'Convert to a PushForm cloud model and move its views to that link; LayOut export then carries pictures of these views' : 'Sign in to convert the model'}
              onClick={() => onConvert(embedded, source.name)}>Edit model</button>
          </span>
        </li>;
      })}
    </ul>
  </div>;
}
