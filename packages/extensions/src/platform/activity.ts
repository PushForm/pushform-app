// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ExtensionPermission } from '@pushform/extension-protocol';
import type { SessionFailure } from '../runtime/host';
import type { BrokerTraffic } from '../runtime/io';

/**
 * The activity record: what happened to each extension on this device, kept locally per account so the user can see
 * it in the extension manager. It names versions, permissions, reasons and network destinations with counts. It
 * never holds request URLs beyond their origin, request or response bodies, log lines, error messages or anything
 * from a document.
 */

/** Who turned an extension off. */
export type DisabledBy = 'user' | 'crash-loop' | 'developer-mode';

/** Why a runtime that was running ended without failing. */
export type StopReason = 'turned-off' | 'replaced' | 'restarted' | 'uninstalled' | 'closed' | 'stopped';

export type ActivityEvent =
  | { readonly type: 'installed'; readonly name: string; readonly version: string; readonly integrity: 'official' | 'unsigned' }
  | { readonly type: 'updated'; readonly name: string; readonly from: string; readonly to: string }
  | { readonly type: 'reloaded'; readonly name: string; readonly version: string }
  | { readonly type: 'granted'; readonly permissions: readonly ExtensionPermission[] }
  | { readonly type: 'revoked'; readonly permissions: readonly ExtensionPermission[] }
  | { readonly type: 'enabled' }
  | { readonly type: 'disabled'; readonly by: DisabledBy }
  | { readonly type: 'uninstalled'; readonly name: string; readonly version: string; readonly settingsDeleted: boolean; readonly by: 'user' | 'policy' }
  | { readonly type: 'activated' }
  | { readonly type: 'stopped'; readonly reason: StopReason }
  | { readonly type: 'failed'; readonly kind: SessionFailure['kind'] }
  /** The network use of one runtime run to one destination origin, updated as it makes requests. */
  | { readonly type: 'egress'; readonly origin: string; readonly requests: number; readonly bytesSent: number; readonly bytesReceived: number };

export interface ActivityEntry {
  /** Unique per entry; an egress entry keeps its key while its run makes requests, so it is updated in place. */
  readonly key: string;
  readonly extensionId: string;
  /** When it happened (ISO 8601), or for egress when the latest request finished. */
  readonly at: string;
  /** Orders entries written in the same millisecond. */
  readonly seq: number;
  readonly event: ActivityEvent;
}

/** Network use counted for one destination origin. */
export type Traffic = BrokerTraffic;

/** All-time network use of an extension to one destination origin, until the user clears its activity. */
export interface EgressTotal extends Traffic {
  readonly extensionId: string;
  readonly origin: string;
  readonly first: string;
  readonly last: string;
}

/** What the extension manager shows: newest entries first, and totals by destination. */
export interface ExtensionActivity {
  readonly entries: readonly ActivityEntry[];
  readonly egress: readonly EgressTotal[];
}

/** How many entries are kept: the newest per extension, and the newest over all extensions. */
export const ACTIVITY_LIMITS = { perExtension: 200, total: 2000 } as const;

export interface ExtensionActivityStore {
  /** Adds an entry, or replaces the one with the same key, then drops the oldest beyond `ACTIVITY_LIMITS`. */
  put(entry: ActivityEntry): Promise<void>;
  /** An extension's entries, oldest first. */
  list(extensionId: string): Promise<ActivityEntry[]>;
  /** Ids of every extension with entries or totals, installed or not. */
  extensions(): Promise<string[]>;
  addEgress(extensionId: string, origin: string, traffic: Traffic, at: string): Promise<void>;
  egress(extensionId: string): Promise<EgressTotal[]>;
  /** Deletes an extension's entries and totals. */
  clear(extensionId: string): Promise<void>;
}

const byTime = (a: ActivityEntry, b: ActivityEntry): number => a.at.localeCompare(b.at) || a.seq - b.seq;

/** The keys to delete so that `entries` fits `ACTIVITY_LIMITS`, dropping the oldest first. */
export function activityOverflow(entries: readonly ActivityEntry[], limits: { perExtension: number; total: number } = ACTIVITY_LIMITS): string[] {
  const sorted = [...entries].sort(byTime);
  const drop = new Set<string>();
  const perExtension = new Map<string, ActivityEntry[]>();
  for (const entry of sorted) {
    const list = perExtension.get(entry.extensionId);
    if (list) list.push(entry); else perExtension.set(entry.extensionId, [entry]);
  }
  for (const list of perExtension.values())
    for (const entry of list.slice(0, Math.max(0, list.length - limits.perExtension))) drop.add(entry.key);
  const kept = sorted.filter((e) => !drop.has(e.key));
  for (const entry of kept.slice(0, Math.max(0, kept.length - limits.total))) drop.add(entry.key);
  return [...drop];
}

export function sortActivity(entries: readonly ActivityEntry[]): ActivityEntry[] {
  return [...entries].sort(byTime);
}

export const addTraffic = (a: Traffic | undefined, b: Traffic): Traffic => ({
  requests: (a?.requests ?? 0) + b.requests, bytesSent: (a?.bytesSent ?? 0) + b.bytesSent, bytesReceived: (a?.bytesReceived ?? 0) + b.bytesReceived,
});

export function memoryActivityStore(limits: { perExtension: number; total: number } = ACTIVITY_LIMITS): ExtensionActivityStore {
  const entries = new Map<string, ActivityEntry>();
  const totals = new Map<string, EgressTotal>();
  const totalKey = (extensionId: string, origin: string) => `${extensionId}\n${origin}`;
  return {
    put: async (entry) => {
      entries.set(entry.key, entry);
      for (const key of activityOverflow([...entries.values()], limits)) entries.delete(key);
    },
    list: async (extensionId) => sortActivity([...entries.values()].filter((e) => e.extensionId === extensionId)),
    extensions: async () => [...new Set([...[...entries.values()].map((e) => e.extensionId), ...[...totals.values()].map((t) => t.extensionId)])],
    addEgress: async (extensionId, origin, traffic, at) => {
      const key = totalKey(extensionId, origin);
      const before = totals.get(key);
      totals.set(key, { extensionId, origin, ...addTraffic(before, traffic), first: before?.first ?? at, last: at });
    },
    egress: async (extensionId) => [...totals.values()].filter((t) => t.extensionId === extensionId).sort((a, b) => a.origin.localeCompare(b.origin)),
    clear: async (extensionId) => {
      for (const [key, entry] of entries) if (entry.extensionId === extensionId) entries.delete(key);
      for (const [key, total] of totals) if (total.extensionId === extensionId) totals.delete(key);
    },
  };
}
