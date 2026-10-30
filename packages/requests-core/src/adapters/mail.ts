// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Transactional mail contract; the Resend implementation is `ResendMail`. */
export interface MailMessage {
  to: string | readonly string[];
  subject: string;
  text: string;
  html: string;
  /** Extra headers such as `X-Request-Id`; providers may ignore them. */
  headers?: Record<string, string> | undefined;
}
export interface Mail {
  /** Send one message from the configured sender with reply-to set to the maintainers' address. */
  send(message: MailMessage): Promise<{ id: string }>;
}
export class MailError extends Error {
  constructor(readonly code: 'auth' | 'rate_limited' | 'unavailable' | 'invalid', message: string, override readonly cause?: unknown) {
    super(message); this.name = 'MailError';
  }
}
/** A mail sink for tests and dry runs. */
export class MemoryMail implements Mail {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<{ id: string }> {
    this.sent.push(message);
    return { id: `mem-${this.sent.length}` };
  }
}
