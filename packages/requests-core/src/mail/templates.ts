// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MailMessage } from '../adapters/mail.ts';
import { KIND_LABEL } from '../agents/brief.ts';
import { issueSections } from '../domain/issue.ts';
import type { Brief, Eligibility, Kind } from '../domain/types.ts';

/**
 * Requester emails as pure functions (historical templates remain readable but are never delivered).
 * Each returns subject, plain text and simple
 * HTML; nothing here reads the clock or the network, so the sweeper can render from an outbox payload.
 */
export interface RequestMailView {
  issueKey: string;
  title: string;
  kind: Kind;
  eligibility: Eligibility;
  requesterEmail: string;
  brief: Brief | null;
  /** The Linear ticket URL, or product home when a historical ticket has no URL. */
  requestUrl: string;
  hostName: string;
  /** Reply-to address of the maintainers. */
  maintainersAddress: string;
}
export interface TrialMailData {
  url: string;
  /** Build agent summary, at most 200 words. */
  summary: string;
  leftOut: string[];
  /** ISO timestamps; `now` is when the email is rendered so the time remaining is deterministic. */
  expiresAt: string;
  now: string;
  script: string[];
  round: number;
  addressed?: string[] | undefined;
  notAddressed?: { item: string; reason: string }[] | undefined;
}
export type MailTemplatePayload =
  | { template: 'filed' }
  | { template: 'relayed_comment'; body: string }
  | { template: 'ready_to_try'; trial: TrialMailData }
  | { template: 'updated_trial'; trial: TrialMailData }
  | { template: 'reminder'; trial: Pick<TrialMailData, 'url' | 'expiresAt' | 'now'> }
  | { template: 'expired' }
  | { template: 'withdrawn' }
  | { template: 'shipped'; version?: string | null | undefined };
export type MailTemplateName = MailTemplatePayload['template'];
export const MAIL_TEMPLATES: readonly MailTemplateName[] =
  ['filed', 'relayed_comment', 'ready_to_try', 'updated_trial', 'reminder', 'expired', 'withdrawn', 'shipped'];
export type RenderedMail = Pick<MailMessage, 'subject' | 'text' | 'html'>;

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'list'; items: string[]; ordered: boolean }
  | { kind: 'quote'; text: string }
  | { kind: 'kv'; rows: [string, string][] };
const p = (text: string): Block => ({ kind: 'p', text });
const h = (text: string): Block => ({ kind: 'h', text });
const list = (items: string[], ordered = false): Block => ({ kind: 'list', items, ordered });
const quote = (text: string): Block => ({ kind: 'quote', text });
const kv = (rows: [string, string][]): Block => ({ kind: 'kv', rows });

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function toText(blocks: Block[]): string {
  return blocks.map(b => {
    switch (b.kind) {
      case 'p': return b.text;
      case 'h': return `${b.text}\n${'-'.repeat(b.text.length)}`;
      case 'list': return b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '-'} ${it}`).join('\n');
      case 'quote': return b.text.split('\n').map(l => `> ${l}`).join('\n');
      case 'kv': return b.rows.map(([k, v]) => `${k}: ${v}`).join('\n');
    }
  }).join('\n\n') + '\n';
}
function toHtml(subject: string, blocks: Block[]): string {
  const body = blocks.map(b => {
    switch (b.kind) {
      case 'p': return `<p>${escapeHtml(b.text).replace(/\n/g, '<br>')}</p>`;
      case 'h': return `<h2>${escapeHtml(b.text)}</h2>`;
      case 'list': return `<${b.ordered ? 'ol' : 'ul'}>${b.items.map(it => `<li>${escapeHtml(it)}</li>`).join('')}</${b.ordered ? 'ol' : 'ul'}>`;
      case 'quote': return `<blockquote>${escapeHtml(b.text).replace(/\n/g, '<br>')}</blockquote>`;
      case 'kv': return `<p>${b.rows.map(([k, v]) => `<strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}`).join('<br>')}</p>`;
    }
  }).join('\n');
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>\n<body style="font-family:system-ui,sans-serif;line-height:1.5;max-width:40em;margin:1em auto;padding:0 1em">\n${body}\n</body></html>\n`;
}
function render(subject: string, blocks: Block[]): RenderedMail { return { subject, text: toText(blocks), html: toHtml(subject, blocks) }; }

const subjectOf = (view: RequestMailView, event: string): string => `[${view.issueKey}] ${event}: ${view.title}`;
const greeting = (): Block => p('Hello,');
const briefBlocks = (brief: Brief | null): Block[] =>
  brief ? issueSections(brief).flatMap(([heading, body]) => [h(heading), p(body)]) : [p('No brief was recorded.')];
const footer = (view: RequestMailView, replyLine = true): Block[] => [
  p(`This email is about request ${view.issueKey} only.`),
  ...(replyLine ? [p(`Questions for the team: reply to ${view.maintainersAddress}.`)] : []),
];
/** Formats an ISO timestamp as `YYYY-MM-DD HH:MM UTC`. */
export function formatUtc(iso: string): string { return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`; }
/** Time remaining in days and hours, floored; "less than an hour" below one hour, "expired" when past. */
export function formatRemaining(fromIso: string, untilIso: string): string {
  const ms = new Date(untilIso).getTime() - new Date(fromIso).getTime();
  if (ms <= 0) return 'expired';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'less than an hour';
  const days = Math.floor(hours / 24), rest = hours % 24;
  const parts = [days ? `${days} day${days === 1 ? '' : 's'}` : '', rest ? `${rest} hour${rest === 1 ? '' : 's'}` : ''].filter(Boolean);
  return parts.join(' and ');
}

/** What happens next for the requester's eligibility. */
export function whatHappensNext(_eligibility: Eligibility, kind: Kind): string {
  return `The team will review your ${kind === 'problem' ? 'report' : 'request'} in Linear and may ask questions by email.`;
}

export function filedMail(view: RequestMailView): RenderedMail {
  const noun = view.kind === 'problem' ? 'problem report' : 'request';
  return render(subjectOf(view, 'Filed'), [
    greeting(),
    p(`Your ${noun} was filed with ${view.hostName} as ${view.issueKey}.`),
    kv([['Identifier', view.issueKey], ['Title', view.title], ['Kind', KIND_LABEL[view.kind]], ['Filed by', view.requesterEmail]]),
    h('What happens next'),
    p(whatHappensNext(view.eligibility, view.kind)),
    ...briefBlocks(view.brief),
    ...footer(view),
  ]);
}
export function relayedCommentMail(view: RequestMailView, body: string): RenderedMail {
  return render(subjectOf(view, 'Message from the team'), [
    greeting(),
    p(`The team wrote about your request ${view.issueKey} (${view.title}):`),
    quote(body.trim()),
    p(`Reply to ${view.maintainersAddress} to follow up on ${view.issueKey}.`),
    // This template must not also invite an email reply, so the footer's reply line is left out.
    ...footer(view, false),
  ]);
}
function trialBlocks(view: RequestMailView, trial: TrialMailData): Block[] {
  return [
    kv([['Identifier', view.issueKey], ['Title', view.title], ['Round', String(trial.round)]]),
    h('What was built'),
    p(trial.summary.trim()),
    h('Deliberately left out'),
    trial.leftOut.length ? list(trial.leftOut) : p('Nothing was left out.'),
    h('Try it'),
    kv([
      ['Trial address', trial.url],
      ['Sign in with', view.requesterEmail],
      ['Trial closes', `${formatUtc(trial.expiresAt)} (${formatRemaining(trial.now, trial.expiresAt)} from now)`],
    ]),
    p('The trial uses separate trial data: your production documents are not there and nothing you do in the trial changes them. The trial closes 24 hours after you give a verdict, or at the time above, whichever comes first.'),
    h('Trial script'),
    trial.script.length ? list(trial.script, true) : p('Not provided'),
    p('Use the feedback panel inside the trial to report what you find and to give your verdict; that is the way results reach the team.'),
  ];
}
export function readyToTryMail(view: RequestMailView, trial: TrialMailData): RenderedMail {
  return render(subjectOf(view, 'Ready to try'), [greeting(), p(`A trial of your request ${view.issueKey} is ready.`), ...trialBlocks(view, trial), ...footer(view)]);
}
export function updatedTrialMail(view: RequestMailView, trial: TrialMailData): RenderedMail {
  const addressed = trial.addressed ?? [], notAddressed = trial.notAddressed ?? [];
  return render(subjectOf(view, 'Updated trial'), [
    greeting(),
    p(`The trial of your request ${view.issueKey} was updated with round ${trial.round}.`),
    h('Your feedback'),
    addressed.length ? list(addressed.map(a => `Addressed: ${a}`)) : p('No items were addressed in this round.'),
    ...(notAddressed.length ? [list(notAddressed.map(n => `Not addressed: ${n.item} (${n.reason})`))] : []),
    ...trialBlocks(view, trial),
    ...footer(view),
  ]);
}
export function reminderMail(view: RequestMailView, trial: Pick<TrialMailData, 'url' | 'expiresAt' | 'now'>): RenderedMail {
  return render(subjectOf(view, 'Trial closes soon'), [
    greeting(),
    p(`The trial of your request ${view.issueKey} (${view.title}) closes at ${formatUtc(trial.expiresAt)}, ${formatRemaining(trial.now, trial.expiresAt)} from now, and no verdict has been given yet.`),
    kv([['Trial address', trial.url], ['Sign in with', view.requesterEmail]]),
    p('Open the trial and use the feedback panel to give your verdict before it closes. Trials cannot be extended.'),
    ...footer(view),
  ]);
}
export function expiredMail(view: RequestMailView): RenderedMail {
  return render(subjectOf(view, 'Trial expired'), [
    greeting(),
    p(`The trial of your request ${view.issueKey} (${view.title}) closed without a verdict and has been removed.`),
    p('The request is now with the team, who will decide how to continue. You will hear from us when there is news.'),
    ...footer(view),
  ]);
}
export function withdrawnMail(view: RequestMailView): RenderedMail {
  return render(subjectOf(view, 'Withdrawn'), [
    greeting(),
    p(`You withdrew your request ${view.issueKey} (${view.title}). It is closed and you will receive no further emails about it.`),
    p('If you change your mind, file a new request from AI Chat in the product.'),
    ...footer(view),
  ]);
}
export function shippedMail(view: RequestMailView, version?: string | null): RenderedMail {
  return render(subjectOf(view, 'Shipped'), [
    greeting(),
    p(`Your request ${view.issueKey} (${view.title}) has shipped${version ? ` in ${view.hostName} ${version}` : ` in ${view.hostName}`}. Reload the product to get it.`),
    p('Thank you for helping improve it.'),
    ...footer(view),
  ]);
}

/** Dispatch by outbox payload; the sweeper calls this for `email` rows. */
export function renderMail(view: RequestMailView, payload: MailTemplatePayload): RenderedMail {
  switch (payload.template) {
    case 'filed': return filedMail(view);
    case 'relayed_comment': return relayedCommentMail(view, payload.body);
    case 'ready_to_try': return readyToTryMail(view, payload.trial);
    case 'updated_trial': return updatedTrialMail(view, payload.trial);
    case 'reminder': return reminderMail(view, payload.trial);
    case 'expired': return expiredMail(view);
    case 'withdrawn': return withdrawnMail(view);
    case 'shipped': return shippedMail(view, payload.version);
  }
}
/** Which templates a requester receives for their eligibility. */
export function receivesTemplate(eligibility: Eligibility, template: MailTemplateName): boolean {
  if (eligibility !== 'none') return true;
  return template === 'filed' || template === 'relayed_comment' || template === 'withdrawn' || template === 'shipped';
}
