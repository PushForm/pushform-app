// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { MailError, type Mail, type MailMessage } from './mail.ts';

export interface ResendMailOptions {
  apiKey: string;
  from: string;
  replyTo: string;
  fetch?: typeof fetch | undefined;
  endpoint?: string | undefined;
}

/** Resend REST adapter: `POST https://api.resend.com/emails` with a bearer key. */
export class ResendMail implements Mail {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  constructor(private readonly options: ResendMailOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? 'https://api.resend.com/emails';
  }
  async send(message: MailMessage): Promise<{ id: string }> {
    const to = typeof message.to === 'string' ? [message.to] : [...message.to];
    if (to.length === 0) throw new MailError('invalid', 'The message has no recipient.');
    const payload = {
      from: this.options.from, to, reply_to: this.options.replyTo, subject: message.subject, text: message.text, html: message.html,
      ...(message.headers ? { headers: message.headers } : {}),
    };
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new MailError('unavailable', 'Could not reach the mail provider.', error);
    }
    const body = (await response.json().catch(() => null)) as { id?: string; message?: string; name?: string } | null;
    if (response.ok && body?.id) return { id: body.id };
    const detail = body?.message ? `: ${body.message}` : '';
    if (response.status === 401 || response.status === 403) throw new MailError('auth', `The mail provider rejected the credentials${detail}`);
    if (response.status === 429) throw new MailError('rate_limited', `The mail provider is rate limiting sends${detail}`);
    if (response.status >= 400 && response.status < 500) throw new MailError('invalid', `The mail provider rejected the message${detail}`);
    throw new MailError('unavailable', `The mail provider returned ${response.status}${detail}`);
  }
}
