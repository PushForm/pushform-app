// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Resend's Receiving API, used by the admin console's `admin-inbox` function. The `email.received` webhook
 * carries only metadata, so the message is fetched with `GET /emails/receiving/{id}` and its attachments, with
 * one-hour download links, with `GET /emails/receiving/{id}/attachments`. Same bearer key as sending.
 */
export interface ReceivedEmail {
  attachmentIds?: string[];
  id: string;
  from: string;
  to: string[];
  cc: string[];
  received_for: string[];
  subject: string;
  created_at: string;
  message_id: string | null;
  html: string | null;
  text: string | null;
}
export interface ReceivedAttachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  download_url: string;
}

export interface InboxMessageContext { inboxId: string; threadId: string }

export interface ResendReceivingOptions {
  apiKey: string;
  fetch?: typeof fetch | undefined;
  endpoint?: string | undefined;
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const stringOr = <T>(value: unknown, fallback: T): string | T => typeof value === 'string' ? value : fallback;

export class ResendReceiving {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  constructor(private readonly options: ResendReceivingOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.endpoint = (options.endpoint ?? 'https://api.resend.com').replace(/\/$/, '');
  }
  private async get(path: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.endpoint}${path}`, { headers: { Authorization: `Bearer ${this.options.apiKey}` } });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !body) throw new Error(`Resend ${path} returned ${response.status}${typeof body?.['message'] === 'string' ? `: ${body['message']}` : ''}`);
    return body;
  }
  async email(id: string, context?: InboxMessageContext): Promise<ReceivedEmail> {
    const path = context
      ? `/inboxes/${encodeURIComponent(context.inboxId)}/threads/${encodeURIComponent(context.threadId)}/emails/${encodeURIComponent(id)}`
      : `/emails/receiving/${encodeURIComponent(id)}`;
    const b = await this.get(path);
    return {
      ...(context ? { attachmentIds: (Array.isArray(b['attachments']) ? b['attachments'] as Record<string, unknown>[] : []).map(a => a['id']).filter((v): v is string => typeof v === 'string') } : {}),
      id: stringOr(b['id'], id), from: stringOr(b['from'], ''), to: strings(b['to']), cc: strings(b['cc']), received_for: strings(b['received_for']),
      subject: stringOr(b['subject'], ''), created_at: stringOr(context ? b['received_at'] : b['created_at'], new Date().toISOString()), message_id: stringOr(b['message_id'], null),
      html: stringOr(b['html'], null), text: stringOr(b['text'], null),
    };
  }
  /** Every attachment of one received email, following `has_more` pages. */
  async attachments(id: string): Promise<ReceivedAttachment[]> {
    const out: ReceivedAttachment[] = [];
    for (let after: string | null = null, page = 0; page < 20; page++) {
      const query: string = after ? `?limit=100&after=${encodeURIComponent(after)}` : '?limit=100';
      const b = await this.get(`/emails/receiving/${encodeURIComponent(id)}/attachments${query}`);
      const data = Array.isArray(b['data']) ? b['data'] as Record<string, unknown>[] : [];
      for (const a of data) {
        if (typeof a['id'] !== 'string' || typeof a['download_url'] !== 'string') continue;
        out.push({ id: a['id'], filename: stringOr(a['filename'], 'attachment'), content_type: stringOr(a['content_type'], 'application/octet-stream'),
          size: typeof a['size'] === 'number' ? a['size'] : 0, download_url: a['download_url'] });
      }
      if (b['has_more'] !== true || data.length === 0) break;
      after = out[out.length - 1]?.id ?? null;
    }
    return out;
  }
  /** The bytes behind a download link (signed; no key needed). */
  async download(url: string): Promise<Uint8Array> {
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`attachment download returned ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
