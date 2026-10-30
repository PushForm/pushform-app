// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';
import { callRpc, type RpcName } from './rpc';
import type { CloudSession } from './CloudSession';

/**
 * Account deletion and file export for the signed-in account. Deletion is a mark that the
 * cloud-sweeper acts on 48 hours later unless it is cancelled; an export is a request the sweeper turns into a zip and
 * an emailed 24-hour link. All rules are enforced by the `cloud_*` functions and RLS; this store only reads the
 * account's own rows and calls those functions.
 */
export interface CloudAccountDeletion {
  readonly requestedAt: string;
  /** When the sweeper deletes the account; it can be cancelled until then. */
  readonly deleteAfter: string;
}
export type CloudExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';
export interface CloudExport {
  readonly id: string;
  readonly status: CloudExportStatus;
  readonly requestedAt: string;
  readonly finishedAt: string | null;
  readonly documentCount: number | null;
  readonly sizeBytes: number | null;
  /** When the emailed link stops working. */
  readonly expiresAt: string | null;
  readonly error: string | null;
}
export interface CloudAccountState {
  /** `unavailable` where the installation has no account functions yet: the UI then offers neither action. */
  readonly status: 'signedOut' | 'loading' | 'ready' | 'unavailable' | 'error';
  readonly ownerId: string | null;
  readonly deletion: CloudAccountDeletion | null;
  /** The account's latest export request. */
  readonly latestExport: CloudExport | null;
  readonly busy: 'delete' | 'cancel' | 'export' | null;
  readonly error: string | null;
}
export interface CloudAccountStore {
  getSnapshot(): CloudAccountState;
  subscribe(listener: () => void): () => void;
  reload(): Promise<void>;
  requestDeletion(): Promise<boolean>;
  cancelDeletion(): Promise<boolean>;
  requestExport(): Promise<boolean>;
  clearError(): void;
}

/** While an export is being built, its status is read again this often. */
const EXPORT_POLL_MS = 15_000;
const EXPORT_COLUMNS = 'id,status,requested_at,finished_at,document_count,size_bytes,expires_at,error';

interface DeletionRow { requested_at: string; delete_after: string }
interface ExportRow { id: string; status: CloudExportStatus; requested_at: string; finished_at: string | null; document_count: number | null;
  size_bytes: number | null; expires_at: string | null; error: string | null }
const deletionOf = (row: DeletionRow | null): CloudAccountDeletion | null => row ? { requestedAt: row.requested_at, deleteAfter: row.delete_after } : null;
const exportOf = (row: ExportRow | null): CloudExport | null => row ? {
  id: row.id, status: row.status, requestedAt: row.requested_at, finishedAt: row.finished_at, documentCount: row.document_count,
  sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes), expiresAt: row.expires_at, error: row.error,
} : null;

function missing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === 'PGRST202' || code === 'PGRST205';
}
function message(error: unknown, fallback: string): string {
  const e = error as { code?: string; message?: string; status?: number } | null;
  if (missing(error)) return 'This is not available for this installation yet.';
  if (e?.status === 401 || e?.message?.includes('cloud_auth')) return 'Sign in again to continue.';
  if (e?.code === '54000' || e?.message?.includes('cloud_rate_limited')) return 'You have asked for five exports in the last 24 hours. Try again later.';
  return fallback;
}

export class CloudAccount implements CloudAccountStore {
  private state: CloudAccountState = { status: 'signedOut', ownerId: null, deletion: null, latestExport: null, busy: null, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private epoch = 0;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly client: Pick<SupabaseClient<Database>, 'from' | 'rpc'>, private readonly session: Pick<CloudSession, 'getSnapshot' | 'subscribe'>,
    private readonly pollMs = EXPORT_POLL_MS) {
    this.unsubscribe = session.subscribe(() => this.follow());
    this.follow();
  }

  getSnapshot = (): CloudAccountState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<CloudAccountState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.schedulePoll();
    for (const listener of this.listeners) listener();
  }
  /** Keeps reading an export's status while the sweeper builds it, so the dialog shows when its email is on its way. */
  private schedulePoll(): void {
    const building = this.state.latestExport?.status === 'queued' || this.state.latestExport?.status === 'running';
    if (!building || this.disposed) { if (this.poll) clearTimeout(this.poll); this.poll = null; return; }
    if (!this.poll) this.poll = setTimeout(() => { this.poll = null; void this.reload(); }, this.pollMs);
  }
  private follow(): void {
    const snapshot = this.session.getSnapshot();
    const owner = snapshot.status === 'signedIn' ? snapshot.user?.id ?? null : null;
    if (owner === this.state.ownerId) return;
    this.epoch++;
    this.update({ status: owner ? 'loading' : 'signedOut', ownerId: owner, deletion: null, latestExport: null, busy: null, error: null });
    if (owner) void this.reload();
  }

  async reload(): Promise<void> {
    const owner = this.state.ownerId, epoch = this.epoch;
    if (!owner) return;
    try {
      const [deletion, latest] = await Promise.all([
        this.client.from('cloud_account_deletions').select('requested_at,delete_after').eq('owner_id', owner).maybeSingle<DeletionRow>(),
        this.client.from('cloud_exports').select(EXPORT_COLUMNS).eq('owner_id', owner).order('requested_at', { ascending: false }).limit(1).maybeSingle<ExportRow>(),
      ]);
      if (epoch !== this.epoch) return;
      if (deletion.error) throw deletion.error;
      if (latest.error) throw latest.error;
      this.update({ status: 'ready', deletion: deletionOf(deletion.data), latestExport: exportOf(latest.data) });
    } catch (error) {
      if (epoch !== this.epoch) return;
      // Before the migration reaches an installation, the account actions are simply not offered.
      this.update(missing(error) ? { status: 'unavailable' } : { status: 'error', error: message(error, 'Could not load your account settings. Check your connection and try again.') });
    }
  }

  private async act<T>(busy: NonNullable<CloudAccountState['busy']>, fn: RpcName, fallback: string, apply: (data: T) => Partial<CloudAccountState>): Promise<boolean> {
    const epoch = this.epoch;
    if (!this.state.ownerId || this.state.busy) return false;
    this.update({ busy, error: null });
    try {
      const { data, error } = await callRpc(this.client, fn);
      if (epoch !== this.epoch) return false;
      if (error) throw error;
      this.update({ busy: null, ...apply(data as T) });
      return true;
    } catch (error) {
      if (epoch === this.epoch) this.update({ busy: null, error: message(error, fallback) });
      return false;
    }
  }

  /** Marks the account for deletion in 48 hours. */
  requestDeletion(): Promise<boolean> {
    return this.act<DeletionRow>('delete', 'cloud_request_account_deletion', 'Could not mark your account for deletion. Try again.',
      row => ({ deletion: deletionOf(row) }));
  }
  /** Cancels the deletion while its 48 hours have not run out. */
  async cancelDeletion(): Promise<boolean> {
    let cancelled = false;
    const ok = await this.act<boolean>('cancel', 'cloud_cancel_account_deletion', 'Could not cancel the deletion. Try again.', done => {
      cancelled = done;
      return done ? { deletion: null } : { error: 'The deletion can no longer be cancelled.' };
    });
    return ok && cancelled;
  }
  /** Asks for a zip of the account's documents, emailed as a 24-hour link. */
  requestExport(): Promise<boolean> {
    return this.act<ExportRow>('export', 'cloud_request_export', 'Could not request the export. Try again.', row => ({ latestExport: exportOf(row) }));
  }

  clearError(): void { this.update({ error: null }); }
  dispose(): void {
    this.disposed = true; this.epoch++;
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
    this.unsubscribe(); this.listeners.clear();
  }
}
