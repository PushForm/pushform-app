// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CatalogModel } from './catalog';

export function exampleModel(patch: Partial<CatalogModel> = {}): CatalogModel {
  return { id: 'workshop-hinge', revision: '1', files: [], creatorProfile:null, previewImage:null, title: 'Workshop hinge', description: 'A small cabinet fitting.',
    creator: 'Example Maker', category: 'Hardware', tags: ['cabinet'], formats: ['STEP'],
    publishedAt: '2026-10-31T12:00:00Z', imageUrl: null,
    source: { name: 'Example Library', url: 'https://example.com/model' },
    licenses: [{ name: 'Attribution 3.0', url: 'https://example.com/license', commercialUse: 'allowed', conditions: ['Credit Example Maker.'] }],
    credits: [{ name: 'Example Maker', url: 'https://example.com/maker', text: 'Original model by Example Maker.' }], ...patch };
}
