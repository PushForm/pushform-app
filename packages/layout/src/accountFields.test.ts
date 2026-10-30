// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { createLayoutDocumentState } from './LayoutDocument';
import { layoutAccountFieldsVersion, setLayoutAccountFields, subscribeLayoutAccountFields } from './accountFields';
import { resolveLayoutText } from './text';

// Account auto-text from the signed-in account's profile.
afterEach(() => setLayoutAccountFields(null));
const state = createLayoutDocumentState();
const page = state.pages.get(state.pageOrder[0]!)!;

it('fills the account tags from the profile and leaves them as typed without one', () => {
  const content = '<FirstName> <LastName> / <FullName> / <CompanyName>.';
  expect(resolveLayoutText(content, page, state)).toBe(content);
  setLayoutAccountFields({ firstName: 'Ada', lastName: 'Lovelace', companyName: 'Analytical Ltd' });
  expect(resolveLayoutText(content, page, state)).toBe('Ada Lovelace / Ada Lovelace / Analytical Ltd.');
  setLayoutAccountFields({ firstName: 'Ada', lastName: 'Lovelace', companyName: null });
  expect(resolveLayoutText('<FullName>, <CompanyName>', page, state)).toBe('Ada Lovelace, ');
});

it('lets a document\'s own custom field of the same name win', () => {
  setLayoutAccountFields({ firstName: 'Ada', lastName: 'Lovelace', companyName: 'Analytical Ltd' });
  const own = createLayoutDocumentState();
  own.customFields.set('CompanyName', 'Client Co');
  expect(resolveLayoutText('<CompanyName>', own.pages.get(own.pageOrder[0]!)!, own)).toBe('Client Co');
});

it('notifies only when a value changes', () => {
  const listener = vi.fn();
  const stop = subscribeLayoutAccountFields(listener);
  const before = layoutAccountFieldsVersion();
  setLayoutAccountFields({ firstName: 'Ada', lastName: 'Lovelace', companyName: null });
  setLayoutAccountFields({ firstName: 'Ada', lastName: 'Lovelace', companyName: null });
  setLayoutAccountFields({ firstName: 'Augusta', lastName: 'Lovelace', companyName: null });
  stop();
  setLayoutAccountFields(null);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(layoutAccountFieldsVersion()).toBe(before + 3);
});
