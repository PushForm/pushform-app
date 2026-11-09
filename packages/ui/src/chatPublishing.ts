// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { COMMONS_CATEGORIES, CommonsCollections, CommonsPublishing, type CloudFilesApi, type CommonsCollection, type CommonsSubmission } from '@pushform/cloud';
import type { CommonsAccount } from '@pushform/commons-ui/account';
import { CUSTOM_LICENSE, detailsFromMetadata, publishLicenses, uniqueLicenses, type LicenseKey, type ModelDetails } from '@pushform/commons-ui/modelDetails';
import { PUBLISH_LICENSES, type PublishProposal } from '@pushform/requests-core';
import type { PreparedPublication, PublishedModel } from '@pushform/requests-ui';
import { cloudLocation } from './cloudDocuments';
import type { CloudAutosave } from './cloudAutosave';
import { commonsDesignId, commonsModelUrl } from './components/PublishSnapshot';
import { editorView, type PublishingSnapshot } from './components/SaveVersionDialog';
import type { DocumentTab } from './session';

/** A save from AI Chat: the cloud version number, and whether a new version was made rather than the current one kept. */
export interface ChatSave { readonly revision: number; readonly saved: boolean }
/** What the publishing dialog starts from for a card's publication. */
export interface PublicationPreset { details: Partial<ModelDetails>; collections: { ids: string[]; names: string[] } }
/** Opens the editor's publishing dialog; resolves with the published model and failed collections, or null when closed without publishing. */
export type OpenPublishing = (snapshot: PublishingSnapshot, preset: PublicationPreset, auto: boolean) => Promise<{ modelId: string; failures: readonly string[] } | null>;

/** The host side of AI Chat's save and publish tools. Publishing is offered only with a Commons account. */
export interface ChatPublishing {
  save(tab: DocumentTab, notes?: string): Promise<ChatSave>;
  info?(tab: DocumentTab): Promise<Record<string, unknown>>;
  prepare?(tab: DocumentTab, proposal: PublishProposal): Promise<PreparedPublication>;
  publish?(prepared: PreparedPublication, auto: boolean): Promise<PublishedModel | null>;
}

interface PublicationState { readonly title: string; readonly details: ModelDetails | null; readonly published: boolean }
interface HostState { readonly snapshot: PublishingSnapshot; readonly preset: PublicationPreset; readonly title: string }

const licenseOf = (key: LicenseKey) => ({ name: key, summary: publishLicenses[key].summary, url: publishLicenses[key].url });
const plainName = (name: string): string => name.replace(/\.(pfl?)$/i, '');
/** A source condition that keeps a copy from being published, as the publishing dialog refuses it. */
const NO_DERIVATIVES = /NoDerivatives|\bND\b/i;

/** The current view as a small JPEG for the card: the same camera the listing picture is drawn from. */
function cardPicture(tab: DocumentTab): string | undefined {
  if (tab.type !== 'model' || typeof document === 'undefined') return undefined;
  const view = editorView(tab);
  if (!view) return undefined;
  const canvas = document.createElement('canvas'), scale = 480 / Math.max(view.width, view.height);
  const width = Math.max(1, Math.round(view.width * scale)), height = Math.max(1, Math.round(view.height * scale));
  try {
    if (!tab.app.viewport.snapshotInto(canvas, width, height, view.camera, { background: '#eef0e8' })) return undefined;
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch { return undefined; }
}

export function chatPublishing({ files, saves, commons, openPublishing }: {
  files: CloudFilesApi; saves: CloudAutosave; commons?: { account?: CommonsAccount | undefined } | undefined; openPublishing: OpenPublishing;
}): ChatPublishing {
  const save = async (tab: DocumentTab, notes?: string): Promise<ChatSave> => {
    const changed = saves.needsSave(tab);
    await saves.saveNow(tab, changed ? notes?.trim() || undefined : undefined);
    const location = cloudLocation(tab.identity);
    if (!location) throw new Error('The saved version could not be confirmed. Try again.');
    const head = await files.head(location.fileId);
    return { revision: head.file.revision_number, saved: changed };
  };
  const account = commons?.account;
  if (!account) return { save };
  const publishing = new CommonsPublishing(account.client), collections = new CommonsCollections(account.client);

  /** The source licenses a copy keeps, and why it cannot be published, from the open model's attribution notices. */
  const sources = (tab: DocumentTab): { retained: string[] | null; blocked: string | null } => {
    if (tab.type !== 'model') return { retained: null, blocked: 'Only 3D models can be published to Commons.' };
    const notices = tab.app.document.doc.state.meta.attributions ?? [];
    if (!notices.length) return { retained: null, blocked: null };
    const licenses = uniqueLicenses(notices.flatMap(notice => notice.licenses));
    const blocked = licenses.some(license => NO_DERIVATIVES.test(license.name))
      ? 'This model includes a source with a no-derivatives condition, so a copy of it cannot be published.' : null;
    return { retained: [...new Set(licenses.map(license => license.name))], blocked };
  };
  /** The model's current publication, found by the saved file it was published from. */
  const publication = async (tab: DocumentTab): Promise<PublicationState | null> => {
    const location = cloudLocation(tab.identity);
    if (!location) return null;
    const id = await commonsDesignId(location.fileId);
    const mine = await publishing.mine();
    const row = mine.models.find(model => model.id === id);
    const revision = mine.revisions.find(item => item.id === (row?.published_revision ?? row?.latest_submission));
    if (!row || !revision) return null;
    const metadata = revision.metadata as CommonsSubmission;
    return { title: metadata.title, details: detailsFromMetadata(metadata), published: !!row.published_revision };
  };
  const ownCollections = async (): Promise<CommonsCollection[]> => {
    const profile = await account.profiles.mine().catch(() => null);
    return profile?.active ? await collections.mine().catch(() => []) : [];
  };

  return {
    save,
    async info(tab) {
      const { retained, blocked } = sources(tab);
      if (blocked) return { available: false, reason: blocked };
      const [current, own] = await Promise.all([publication(tab).catch(() => null), ownCollections()]);
      return {
        available: true, document: plainName(tab.name),
        published: current?.published ? { title: current.title, category: current.details?.category, license: current.details?.license, description: current.details?.description } : null,
        retainedSourceLicenses: retained,
        collections: own.map(collection => ({ name: collection.title, visibility: collection.visibility, models: collection.modelIds.length })),
        categories: COMMONS_CATEGORIES, licenses: PUBLISH_LICENSES.map(key => (key === 'other' ? { key, summary: 'The publisher\'s own written terms.' } : { key, summary: publishLicenses[key].summary })),
      };
    },
    async prepare(tab, proposal) {
      const { retained, blocked } = sources(tab);
      if (blocked) throw new Error(blocked);
      const saved = await save(tab, proposal.notes);
      const location = cloudLocation(tab.identity);
      if (!location) throw new Error('The saved version could not be confirmed. Try again.');
      const view = editorView(tab);
      const snapshot: PublishingSnapshot = { ...await files.openRevision(location.revisionId), ...(view ? { view } : {}) };
      const [current, own] = await Promise.all([publication(tab).catch(() => null), ownCollections()]);
      const base = current?.details;
      const category = COMMONS_CATEGORIES.find(name => name.toLowerCase() === proposal.category?.trim().toLowerCase()) ?? base?.category ?? 'Other';
      const license: LicenseKey | 'other' = retained ? (base?.license ?? 'CC BY 4.0') : proposal.license ?? base?.license ?? 'CC BY 4.0';
      const title = proposal.title?.trim() || current?.title || plainName(tab.name);
      const description = proposal.description?.trim() ?? base?.description ?? '';
      const details: Partial<ModelDetails> = {
        title, description, category,
        ...(retained ? {} : { license, terms: license === 'other' ? proposal.licenseTerms?.trim() ?? base?.terms ?? '' : '' }),
      };
      if (!retained && license === 'other' && !details.terms) throw new Error('A license of your own needs its terms. Say what others may do with the model.');
      const chosen = [...new Set((proposal.collections ?? []).map(name => name.trim()).filter(Boolean))];
      const matched = chosen.map(name => ({ name, existing: own.find(collection => collection.title.toLowerCase() === name.toLowerCase()) }));
      const preset: PublicationPreset = { details,
        collections: { ids: matched.flatMap(item => (item.existing ? [item.existing.id] : [])), names: matched.flatMap(item => (item.existing ? [] : [item.name])) } };
      const host: HostState = { snapshot, preset, title };
      return {
        revision: snapshot.file.revision_number,
        savedLine: saved.saved ? `Saved version ${saved.revision}.` : `No changes since version ${saved.revision}. Nothing new was saved.`,
        update: !!current?.published, title, description, category,
        license: retained ? null : license === 'other' ? { name: CUSTOM_LICENSE, summary: details.terms ?? '', url: null } : licenseOf(license),
        retained, collections: matched.map(item => ({ name: item.existing?.title ?? item.name, isNew: !item.existing })),
        picture: cardPicture(tab), host,
      };
    },
    async publish(prepared, auto) {
      const { snapshot, preset, title } = prepared.host as HostState;
      const made = await openPublishing(snapshot, preset, auto);
      return made ? { title, url: commonsModelUrl(made.modelId), failedCollections: made.failures } : null;
    },
  };
}
