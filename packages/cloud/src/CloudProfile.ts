// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';
import { callRpc, type RpcArgs } from './rpc';
import type { CloudSession } from './CloudSession';

/**
 * Account profiles: who the user is, collected once after first sign-in and editable from account
 * details. The stored row is the completion flag; a profile whose accepted terms are older than CLOUD_TERMS_VERSION
 * shows the step again so the new terms can be accepted.
 */
export type CloudAccountType = 'company' | 'individual';
export type CloudCompanySize = '1-10' | '11-50' | '51-200' | '201-1000' | '1001+';
export type CloudIndustry = 'architecture' | 'interior_design' | 'landscape_architecture' | 'construction' | 'engineering' |
  'woodworking_fabrication' | 'product_design' | 'real_estate' | 'education' | 'entertainment_design' | 'hobbyist' | 'other';

export const CLOUD_COMPANY_SIZES: readonly { id: CloudCompanySize; label: string }[] = [
  { id: '1-10', label: '1–10 people' }, { id: '11-50', label: '11–50 people' }, { id: '51-200', label: '51–200 people' },
  { id: '201-1000', label: '201–1,000 people' }, { id: '1001+', label: '1,001 or more people' },
];
export const CLOUD_INDUSTRIES: readonly { id: CloudIndustry; label: string }[] = [
  { id: 'architecture', label: 'Architecture' }, { id: 'interior_design', label: 'Interior design' },
  { id: 'landscape_architecture', label: 'Landscape architecture' }, { id: 'construction', label: 'Construction and contracting' },
  { id: 'engineering', label: 'Engineering' }, { id: 'woodworking_fabrication', label: 'Woodworking and fabrication' },
  { id: 'product_design', label: 'Product and industrial design' }, { id: 'real_estate', label: 'Real estate' },
  { id: 'education', label: 'Education' }, { id: 'entertainment_design', label: 'Entertainment and set design' },
  { id: 'hobbyist', label: 'Hobbyist or personal' }, { id: 'other', label: 'Other' },
];
/** The effective date of the Terms of Use the product asks users to accept. */
export const CLOUD_TERMS_VERSION = '2026-10-27';
export const CLOUD_TERMS_URL = 'https://pushform.io/terms.html';
export const PROFILE_NAME_LIMIT = 100, PROFILE_COMPANY_LIMIT = 200, PROFILE_INDUSTRY_OTHER_LIMIT = 100;

export interface CloudProfile {
  readonly firstName: string;
  readonly lastName: string;
  readonly accountType: CloudAccountType;
  readonly companyName: string | null;
  readonly companySize: CloudCompanySize | null;
  readonly industry: CloudIndustry;
  readonly industryOther: string | null;
  readonly termsVersion: string;
  readonly termsAcceptedAt: string;
  readonly completedAt: string;
  readonly updatedAt: string;
}
/** What the signup step and account details submit. `acceptTerms` accepts CLOUD_TERMS_VERSION; it cannot be withdrawn. */
export interface CloudProfileInput {
  firstName: string;
  lastName: string;
  accountType: CloudAccountType | null;
  companyName: string;
  companySize: CloudCompanySize | null;
  industry: CloudIndustry | null;
  industryOther: string;
  acceptTerms: boolean;
}
export type CloudProfileField = 'firstName' | 'lastName' | 'accountType' | 'companyName' | 'companySize' | 'industry' | 'industryOther' | 'acceptTerms';

/** A completed profile whose accepted terms are current. Missing or outdated profiles show the signup step. */
export function cloudProfileComplete(profile: CloudProfile | null): boolean {
  return profile !== null && profile.termsVersion >= CLOUD_TERMS_VERSION;
}
export function cloudProfileFullName(profile: Pick<CloudProfile, 'firstName' | 'lastName'>): string {
  return `${profile.firstName} ${profile.lastName}`.trim();
}
/** Form values for a profile, or a blank form. Terms count as accepted only when the current version was. */
export function cloudProfileInput(profile: CloudProfile | null): CloudProfileInput {
  return profile ? {
    firstName: profile.firstName, lastName: profile.lastName, accountType: profile.accountType,
    companyName: profile.companyName ?? '', companySize: profile.companySize, industry: profile.industry,
    industryOther: profile.industryOther ?? '', acceptTerms: cloudProfileComplete(profile),
  } : { firstName: '', lastName: '', accountType: null, companyName: '', companySize: null, industry: null, industryOther: '', acceptTerms: false };
}

function hasControl(value: string): boolean { return /\p{Cc}/u.test(value); }
function textError(value: string, limit: number, label: string): string | null {
  const text = value.trim();
  if (!text) return `Enter your ${label}.`;
  if (text.length > limit || hasControl(text)) return `Use up to ${limit} characters for your ${label}.`;
  return null;
}
/** Field messages for an input the server would refuse; empty when it can be saved. */
export function cloudProfileErrors(input: CloudProfileInput): Partial<Record<CloudProfileField, string>> {
  const errors: Partial<Record<CloudProfileField, string>> = {};
  const first = textError(input.firstName, PROFILE_NAME_LIMIT, 'first name'); if (first) errors.firstName = first;
  const last = textError(input.lastName, PROFILE_NAME_LIMIT, 'last name'); if (last) errors.lastName = last;
  if (!input.accountType) errors.accountType = 'Choose Company or Individual.';
  if (input.accountType === 'company') {
    const company = textError(input.companyName, PROFILE_COMPANY_LIMIT, 'company name'); if (company) errors.companyName = company;
    if (!input.companySize || !CLOUD_COMPANY_SIZES.some(size => size.id === input.companySize)) errors.companySize = 'Choose your company size.';
  }
  if (!input.industry || !CLOUD_INDUSTRIES.some(industry => industry.id === input.industry)) errors.industry = 'Choose your industry.';
  if (input.industry === 'other') {
    const other = textError(input.industryOther, PROFILE_INDUSTRY_OTHER_LIMIT, 'industry'); if (other) errors.industryOther = other;
  }
  if (!input.acceptTerms) errors.acceptTerms = 'Accept the Terms of Use to continue.';
  return errors;
}
/** The `cloud_save_profile` parameters. An Individual sends no company fields; only Other sends its description. */
export function cloudProfileParams(input: CloudProfileInput): RpcArgs<'cloud_save_profile'> {
  const company = input.accountType === 'company';
  return {
    p_first_name: input.firstName.trim(), p_last_name: input.lastName.trim(), p_account_type: input.accountType,
    p_company_name: company ? input.companyName.trim() : null, p_company_size: company ? input.companySize : null,
    p_industry: input.industry, p_industry_other: input.industry === 'other' ? input.industryOther.trim() : null,
    p_terms_version: input.acceptTerms ? CLOUD_TERMS_VERSION : null,
  };
}

interface ProfileRow {
  first_name: string; last_name: string; account_type: CloudAccountType; company_name: string | null;
  company_size: CloudCompanySize | null; industry: CloudIndustry; industry_other: string | null; terms_version: string;
  terms_accepted_at: string; completed_at: string; updated_at: string;
}
function fromRow(row: ProfileRow): CloudProfile {
  return {
    firstName: row.first_name, lastName: row.last_name, accountType: row.account_type, companyName: row.company_name,
    companySize: row.company_size, industry: row.industry, industryOther: row.industry_other, termsVersion: row.terms_version,
    termsAcceptedAt: row.terms_accepted_at, completedAt: row.completed_at, updatedAt: row.updated_at,
  };
}
function message(error: unknown, fallback: string): string {
  const e = error as { code?: string; message?: string; status?: number } | null;
  if (e?.code === '42P01' || e?.code === 'PGRST202' || e?.code === 'PGRST205') return 'Account profiles are not set up for this installation yet.';
  if (e?.status === 401 || e?.message?.includes('cloud_auth')) return 'Sign in again to update your profile.';
  if (e?.code === '23514' || e?.message?.includes('cloud_invalid')) return 'Check the highlighted fields and try again.';
  return fallback;
}

export interface CloudProfileState {
  /** `signedOut` without an account; `loading` until the signed-in account's profile has been read. */
  readonly status: 'signedOut' | 'loading' | 'ready' | 'error';
  readonly ownerId: string | null;
  readonly profile: CloudProfile | null;
  readonly saving: boolean;
  readonly error: string | null;
}
export interface CloudProfileStore {
  getSnapshot(): CloudProfileState;
  subscribe(listener: () => void): () => void;
  reload(): Promise<void>;
  /** Saves the signed-in account's profile; false with `error` set when it was refused or could not be sent. */
  save(input: CloudProfileInput): Promise<boolean>;
  clearError(): void;
}

/** The signed-in account's profile, read when the account changes. All rules are also enforced by SQL and RLS. */
export class CloudProfiles implements CloudProfileStore {
  private state: CloudProfileState = { status: 'signedOut', ownerId: null, profile: null, saving: false, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private epoch = 0;
  private disposed = false;

  constructor(private readonly client: Pick<SupabaseClient<Database>, 'from' | 'rpc'>, private readonly session: Pick<CloudSession, 'getSnapshot' | 'subscribe'>) {
    this.unsubscribe = session.subscribe(() => this.follow());
    this.follow();
  }

  getSnapshot = (): CloudProfileState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<CloudProfileState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private signedInUser(): string | null {
    const snapshot = this.session.getSnapshot();
    return snapshot.status === 'signedIn' ? snapshot.user?.id ?? null : null;
  }
  private follow(): void {
    const owner = this.signedInUser();
    if (owner === this.state.ownerId) return;
    this.epoch++;
    this.update({ status: owner ? 'loading' : 'signedOut', ownerId: owner, profile: null, saving: false, error: null });
    if (owner) void this.reload();
  }

  async reload(): Promise<void> {
    const owner = this.state.ownerId, epoch = this.epoch;
    if (!owner) return;
    this.update({ status: 'loading', error: null });
    try {
      const { data, error } = await this.client.from('cloud_profiles').select('*').eq('owner_id', owner).maybeSingle<ProfileRow>();
      if (epoch !== this.epoch) return;
      if (error) throw error;
      this.update({ status: 'ready', profile: data ? fromRow(data) : null });
    } catch (error) {
      if (epoch === this.epoch) this.update({ status: 'error', error: message(error, 'Could not load your profile. Check your connection and try again.') });
    }
  }

  async save(input: CloudProfileInput): Promise<boolean> {
    const owner = this.state.ownerId, epoch = this.epoch;
    if (!owner || this.state.saving) return false;
    if (Object.keys(cloudProfileErrors({ ...input, acceptTerms: input.acceptTerms || this.state.profile !== null })).length) {
      this.update({ error: 'Check the highlighted fields and try again.' }); return false;
    }
    this.update({ saving: true, error: null });
    try {
      const { data, error } = await callRpc(this.client, 'cloud_save_profile', cloudProfileParams(input));
      if (epoch !== this.epoch) return false;
      if (error) throw error;
      this.update({ status: 'ready', profile: fromRow(data as ProfileRow), saving: false });
      return true;
    } catch (error) {
      if (epoch === this.epoch) this.update({ saving: false, error: message(error, 'Could not save your profile. Check your connection and try again.') });
      return false;
    }
  }

  clearError(): void { this.update({ error: null }); }
  dispose(): void { this.disposed = true; this.epoch++; this.unsubscribe(); this.listeners.clear(); }
}
