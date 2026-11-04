// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { COMMONS_CATEGORIES, commonsFileExtension, commonsFileKind, type CommonsSubmission } from '@pushform/cloud';

const credit = 'Credit the creator.';
/** The licenses a publisher can choose, stored under their short names. Other records the publisher's own terms. */
export const publishLicenses = {
  'CC BY 4.0': { label: 'Creative Commons Attribution 4.0', summary: 'Others may share and adapt it, even commercially, with credit.',
    url: 'https://creativecommons.org/licenses/by/4.0/', commercialUse: 'allowed' as const, conditions: [credit] },
  'CC BY-SA 4.0': { label: 'Creative Commons Attribution-ShareAlike 4.0', summary: 'Others may share and adapt it, even commercially, with credit, sharing adaptations under the same license.',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/', commercialUse: 'allowed' as const, conditions: [credit, 'Share adaptations under the same license.'] },
  'CC BY-NC 4.0': { label: 'Creative Commons Attribution-NonCommercial 4.0', summary: 'Others may share and adapt it for non-commercial use, with credit.',
    url: 'https://creativecommons.org/licenses/by-nc/4.0/', commercialUse: 'restricted' as const, conditions: [credit, 'Non-commercial use only.'] },
  'CC BY-NC-SA 4.0': { label: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0', summary: 'Others may share and adapt it for non-commercial use, with credit, sharing adaptations under the same license.',
    url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/', commercialUse: 'restricted' as const, conditions: [credit, 'Non-commercial use only.', 'Share adaptations under the same license.'] },
  'CC BY-ND 4.0': { label: 'Creative Commons Attribution-NoDerivatives 4.0', summary: 'Others may share it unchanged, even commercially, with credit.',
    url: 'https://creativecommons.org/licenses/by-nd/4.0/', commercialUse: 'allowed' as const, conditions: [credit, 'Do not share modified versions.'] },
  'CC BY-NC-ND 4.0': { label: 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0', summary: 'Others may share it unchanged for non-commercial use, with credit.',
    url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/', commercialUse: 'restricted' as const, conditions: [credit, 'Non-commercial use only.', 'Do not share modified versions.'] },
  'CC0 1.0': { label: 'Public domain (CC0 1.0)', summary: 'Anyone may use it for any purpose, without credit.',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/', commercialUse: 'allowed' as const, conditions: [] as string[] },
};
export type LicenseKey = keyof typeof publishLicenses;
export type LicenseChoice = LicenseKey | 'other';
export const CUSTOM_LICENSE = 'Custom license';
export const RIGHTS_BASIS = 'I created and own this model, or have the right to redistribute it and every included file under the selected license.';
export const TITLE_LIMIT = 100;
export const DESCRIPTION_LIMIT = 12000;
export const CATEGORIES = COMMONS_CATEGORIES;

/** What the details step edits. */
export interface ModelDetails { title: string; description: string; category: string; license: LicenseChoice; terms: string }

/** A title from a file name: no extension, separators as spaces, at most the title limit. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (base || 'Untitled model').slice(0, TITLE_LIMIT).trim();
}
export const termLines = (terms: string): string[] => terms.split('\n').map((line) => line.trim()).filter(Boolean);

/** Why the details cannot be saved or published yet, or null when they can. */
export function detailsProblem(details: ModelDetails): string | null {
  const title = details.title.trim();
  if (!title) return 'Add a title.';
  if (title.length > TITLE_LIMIT) return `Keep the title to ${TITLE_LIMIT} characters.`;
  if (details.description.length > DESCRIPTION_LIMIT) return `Keep the description to ${DESCRIPTION_LIMIT.toLocaleString()} characters.`;
  if (!(CATEGORIES as readonly string[]).includes(details.category)) return 'Choose a category.';
  if (details.license === 'other') {
    const lines = termLines(details.terms);
    if (!lines.length) return 'Describe your license terms.';
    if (lines.length > 50 || lines.some((line) => line.length > 1000)) return 'Keep your terms to 50 lines of at most 1,000 characters each.';
  }
  return null;
}

/** Details read back from a saved revision. */
export function detailsFromMetadata(metadata: CommonsSubmission | undefined): ModelDetails {
  const first = metadata?.licenses[0];
  const known = first && first.name in publishLicenses;
  return {
    title: metadata?.title ?? '', description: metadata?.description ?? '',
    category: metadata && (CATEGORIES as readonly string[]).includes(metadata.category) ? metadata.category : 'Other',
    license: !first ? 'CC BY 4.0' : known ? first.name as LicenseKey : 'other',
    terms: first && !known ? [...(first.name === CUSTOM_LICENSE ? [] : [first.name]), ...first.conditions].join('\n') : '',
  };
}

/** Model formats shown on the model page: one per model file, by extension. */
export function formatsOf(fileNames: string[]): string[] {
  const formats = [...new Set(fileNames.filter((name) => commonsFileKind(name) === 'model').map((name) => commonsFileExtension(name).toUpperCase()))];
  return formats.length ? formats : ['PF'];
}

/** The submission for these details. Earlier notices on the revision (source, credits, extra licenses) are kept. */
export function metadataFor(details: ModelDetails, creator: string, fileNames: string[], previous?: CommonsSubmission): CommonsSubmission {
  const license = details.license === 'other'
    ? { name: CUSTOM_LICENSE, url: null, commercialUse: 'unknown' as const, conditions: termLines(details.terms) }
    : { name: details.license, url: publishLicenses[details.license].url, commercialUse: publishLicenses[details.license].commercialUse, conditions: [...publishLicenses[details.license].conditions] };
  return {
    title: details.title.trim(), description: details.description, category: details.category, creator,
    tags: previous?.tags ?? [], formats: formatsOf(fileNames), imageUrl: previous?.imageUrl ?? null, source: previous?.source ?? null,
    licenses: [license, ...(previous?.licenses.slice(1) ?? [])],
    credits: previous?.credits ?? [{ name: creator, url: null, text: `Original model by ${creator}.` }],
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
