// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Account auto-text: tags filled from the signed-in account's profile. Documents are private to
 * their owner, so the values are always the owner's. A document's own custom field of the same name wins.
 */
export const LAYOUT_ACCOUNT_TAGS: readonly string[] = ['FirstName', 'LastName', 'FullName', 'CompanyName'];

export interface LayoutAccountProfile {
  readonly firstName: string;
  readonly lastName: string;
  /** Null for an Individual: `<CompanyName>` shows nothing. */
  readonly companyName: string | null;
}

const NONE: ReadonlyMap<string, string> = new Map();
let fields = NONE, version = 0;
const listeners = new Set<() => void>();

/** Replace the account values; null (signed out) leaves the tags visible as typed. */
export function setLayoutAccountFields(profile: LayoutAccountProfile | null): void {
  const next = profile ? new Map([
    ['FirstName', profile.firstName], ['LastName', profile.lastName],
    ['FullName', `${profile.firstName} ${profile.lastName}`.trim()], ['CompanyName', profile.companyName ?? ''],
  ]) : NONE;
  if ([...LAYOUT_ACCOUNT_TAGS].every(tag => next.get(tag) === fields.get(tag))) return;
  fields = next; version++;
  for (const listener of listeners) listener();
}
/** The current values by tag name. */
export function layoutAccountFields(): ReadonlyMap<string, string> { return fields; }
/** Increments on every change, so drawings that show account tags can repaint. */
export function layoutAccountFieldsVersion(): number { return version; }
export function subscribeLayoutAccountFields(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
