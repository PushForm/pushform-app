// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';
import type { CloudSession } from './CloudSession';

export type BillingInterval = 'month' | 'year';
export type BillingReturn = 'success' | 'cancelled' | 'returned';
const interval = z.enum(['month', 'year']);
const summarySchema = z.object({
  available: z.boolean(),
  offers: z.array(z.object({ interval, amount: z.number().int().nonnegative().safe(), currency: z.string().regex(/^[a-zA-Z]{3}$/) })),
  subscription: z.object({ status: z.string(), interval: interval.nullable(), currentPeriodEnd: z.iso.datetime({ offset: true }).nullable(), cancelAtPeriodEnd: z.boolean() }).nullable(),
  canManageBilling: z.boolean(),
});
export type BillingSummary = z.infer<typeof summarySchema>;
export interface CloudBillingState {
  readonly status: 'signedOut' | 'loading' | 'ready' | 'error';
  readonly ownerId: string | null;
  readonly summary: BillingSummary | null;
  readonly busy: 'checkout' | 'portal' | null;
  readonly returned: BillingReturn | null;
  readonly error: string | null;
}
export interface CloudBillingStore {
  getSnapshot(): CloudBillingState;
  subscribe(listener: () => void): () => void;
  reload(): Promise<void>;
  checkout(interval: BillingInterval): Promise<string | null>;
  portal(): Promise<string | null>;
  clearReturn(): void;
}

/** Checkout return parameters are a notice to refresh, never proof of payment. */
export function billingReturnFromUrl(url: URL): BillingReturn | null {
  const value = url.searchParams.get('billing');
  return value === 'success' || value === 'cancelled' || value === 'returned' ? value : null;
}

/** Only Stripe's hosted payment pages may receive billing navigation. */
export function billingHostedUrl(value: unknown, kind: 'checkout' | 'portal'): string {
  const parsed = z.object({ url: z.url() }).parse(value);
  const url = new URL(parsed.url);
  const host = kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com';
  if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password)
    throw new Error('Invalid billing destination');
  return url.href;
}

/** Displays account billing state without changing file access or editing permissions. */
export class CloudBilling implements CloudBillingStore {
  private state: CloudBillingState = { status: 'signedOut', ownerId: null, summary: null, busy: null, returned: null, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private epoch = 0;
  private request = 0;
  private disposed = false;
  private initialReturn: BillingReturn | null;

  constructor(private readonly client: Pick<SupabaseClient<Database>, 'functions'>,
    private readonly session: Pick<CloudSession, 'getSnapshot' | 'subscribe'>, returned: BillingReturn | null = null) {
    this.initialReturn = returned;
    this.unsubscribe = session.subscribe(() => this.follow());
    this.follow();
  }
  getSnapshot = (): CloudBillingState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<CloudBillingState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private follow(): void {
    const session = this.session.getSnapshot();
    const owner = session.status === 'signedIn' ? session.user?.id ?? null : null;
    if (owner === this.state.ownerId) return;
    this.epoch++;
    const returned = owner ? this.initialReturn : null;
    if (owner) this.initialReturn = null;
    this.update({ status: owner ? 'loading' : 'signedOut', ownerId: owner, summary: null, busy: null, error: null, returned });
    if (owner) void this.reload();
  }
  async reload(): Promise<void> {
    if (!this.state.ownerId || this.disposed) return;
    const epoch = this.epoch, request = ++this.request;
    try {
      const { data, error } = await this.client.functions.invoke('billing-status', { body: {} });
      if (this.disposed || epoch !== this.epoch || request !== this.request) return;
      if (error) throw error;
      const summary = summarySchema.parse(data);
      this.update({ status: 'ready', summary, error: null });
    } catch {
      if (epoch === this.epoch && request === this.request)
        this.update({ status: 'error', error: 'Could not load billing. Check your connection and try again.' });
    }
  }
  private async destination(kind: 'checkout' | 'portal', body: Record<string, string>): Promise<string | null> {
    const epoch = this.epoch;
    if (!this.state.ownerId || this.state.busy || this.disposed) return null;
    this.update({ busy: kind, error: null });
    try {
      const { data, error } = await this.client.functions.invoke(`billing-${kind}`, { body });
      if (this.disposed || epoch !== this.epoch) return null;
      if (error) throw error;
      const url = billingHostedUrl(data, kind);
      this.update({ busy: null });
      return url;
    } catch {
      if (epoch === this.epoch) this.update({ busy: null, error: 'Could not open billing. Please try again.' });
      return null;
    }
  }
  checkout(interval: BillingInterval): Promise<string | null> { return this.destination('checkout', { interval }); }
  portal(): Promise<string | null> { return this.destination('portal', {}); }
  clearReturn(): void { this.update({ returned: null }); }
  dispose(): void { this.disposed = true; this.epoch++; this.unsubscribe(); this.listeners.clear(); }
}
