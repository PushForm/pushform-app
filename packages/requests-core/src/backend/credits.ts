// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { RoundStat } from '../agents/client.ts';
import type { ConversationPath } from '../domain/types.ts';

/** What the account view and the chat show of an account's AI allowance. Every field is a concrete value: there is no unlimited plan. */
export interface CreditSummary {
  plan: 'free' | 'paid';
  /** Credits left across the account's buckets. */
  remaining: number;
  /** The size of the allowance the account draws on: the monthly allowance when paid, the one-time grant when free. */
  allowance: number;
  refill: { kind: 'none' } | { kind: 'monthly'; at: string };
}

/** The kind of conversation a model call belongs to, as the usage ledger records it. */
export type UsagePath = 'help' | 'filing' | 'document' | 'render_review' | 'acknowledge' | 'system' | 'adjustment';

export const usagePathOf = (path: ConversationPath, editing: boolean): UsagePath => (editing ? 'document' : path === 'help' ? 'help' : 'filing');

/** One metered model call. `callId` is unique per call, so recording it twice charges once. */
export interface UsageCall {
  callId: string; ownerId: string; turnId: string | null; conversationId: string | null; orgId: string | null;
  path: UsagePath; provider: string; model: string;
  input: number; output: number; cacheRead: number; cacheWrite: number; estimated: boolean;
}

/** What the backend needs of the credits store; `ServiceDb` is the implementation and the tests supply a fake. */
export interface CreditsPort {
  creditSync(ownerId: string): Promise<CreditSummary>;
  creditRecord(call: UsageCall): Promise<CreditSummary>;
}

export const usageOfRound = (stat: RoundStat) => ({ input: stat.input, output: stat.output, cacheRead: stat.cacheRead, cacheWrite: stat.cacheWrite, estimated: stat.interrupted === true });

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/**
 * The sentence for an account that has no credits left. The server writes it, so no client has to build a sentence
 * from a number it might not have. The refill date is shown in UTC; the client may restate it in the viewer's locale.
 */
export function creditsExhaustedMessage(summary: CreditSummary): string {
  if (summary.plan === 'paid' && summary.refill.kind === 'monthly') {
    return `You've used this month's AI credits. They refill on ${dateFormat.format(new Date(summary.refill.at))}.`;
  }
  return summary.plan === 'paid' ? "You've used this month's AI credits. They refill soon." : "You've used your free AI credits. Subscribe to keep chatting.";
}
