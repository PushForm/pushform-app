// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';
import type { CloudSession } from './CloudSession';
import type { CloudProfileStore } from './CloudProfile';
import { callRpc } from './rpc';

const KEY = 'pushform:campaign-handoff';
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function rememberCampaign(url: URL, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null): string | null {
  const values = url.searchParams.getAll('campaignHandoff');
  try {
    if (values.length) {
      storage?.removeItem(KEY);
      if (url.pathname === '/' && values.length === 1 && TOKEN.test(values[0]!)) storage?.setItem(KEY, values[0]!);
    }
    const token = storage?.getItem(KEY);
    return token && TOKEN.test(token) ? token : null;
  } catch { return null; }
}
export function forgetCampaign(storage: Pick<Storage, 'removeItem'> | null): void { try { storage?.removeItem(KEY); } catch { /* Optional storage. */ } }

export class CloudCampaign {
  constructor(private readonly client: Pick<SupabaseClient<Database>, 'rpc'>) {}
  async claim(token: string, owner: string): Promise<void> {
    if (!TOKEN.test(token)) return;
    const { error } = await callRpc(this.client, 'cloud_claim_campaign', { p_token: token, p_expected_owner: owner });
    if (error) throw new Error('Campaign source could not be saved.');
  }
}

/** Bind the pending handoff to the first eligible owner only. No identity goes to analytics. */
export function followCampaign(session: Pick<CloudSession, 'getSnapshot' | 'subscribe'>,
  profiles: CloudProfileStore | undefined, campaign: Pick<CloudCampaign, 'claim'> | undefined,
  token: string | null, clear: () => void, enabled: () => boolean): () => void {
  let owner: string | null = null, pending = token, sending = false;
  const discard = () => { pending = null; clear(); };
  const follow = () => {
    const state = session.getSnapshot();
    const current = state.status === 'signedIn' ? state.user?.id ?? null : null;
    if (owner && current !== owner) { discard(); return; }
    if (current) owner = current;
    if (!pending || sending || !current || !profiles || !campaign) return;
    const profile = profiles.getSnapshot();
    if (!enabled()) { discard(); return; }
    if (profile.status !== 'ready' || profile.ownerId !== current || !profile.profile) return;
    if (profile.profile.analyticsOptIn !== true) { discard(); return; }
    sending = true;
    const value = pending;
    // The authenticated RPC validates the owner and saved choice again.
    void campaign.claim(value, current).then(discard).catch(() => { discard(); }).finally(() => { sending = false; });
  };
  const unsubscribe = session.subscribe(follow), unprofile = profiles?.subscribe(follow);
  follow();
  return () => { unsubscribe(); unprofile?.(); pending = null; };
}
