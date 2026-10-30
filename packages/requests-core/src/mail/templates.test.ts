// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Eligibility, FeatureBrief, ProblemReport } from '../domain/types.ts';
import { expiredMail, filedMail, formatRemaining, formatUtc, MAIL_TEMPLATES, readyToTryMail, receivesTemplate, relayedCommentMail, reminderMail, renderMail, shippedMail, updatedTrialMail, whatHappensNext, withdrawnMail, type MailTemplatePayload, type RequestMailView, type TrialMailData } from './templates.ts';

const brief: FeatureBrief = {
  kind: 'feature', problem: 'I cannot nudge a Layout viewport with the keyboard.', workaround: null, desired: 'Arrow keys move the selected viewport by 1 mm.',
  acceptance: ['When I select a viewport and press Right, then it moves 1 mm right.', 'When nothing is selected and I press Right, then the page scrolls as before.'],
  mustNotChange: 'Mouse dragging of viewports.', area: 'Layout', importance: { level: 'important', reason: 'Precise placement is slow with the mouse.' }, estimatedClass: 'C3',
};
const report: ProblemReport = {
  kind: 'problem', steps: ['Open a model', 'Push/pull a face by 0 mm'], expected: 'Nothing changes.', happened: 'The face disappears & the <model> breaks.', frequency: 'always',
  area: 'Modeling', impact: 'cannot_work', estimatedClass: 'C3', environment: { build: '0.4.2 (abc1234)', browser: 'Firefox 150', os: 'macOS 26', documentType: 'model', at: '2026-10-23T10:00:00.000Z' },
};
const view = (eligibility: Eligibility, extra: Partial<RequestMailView> = {}): RequestMailView => ({
  issueKey: 'FRQ-123', title: 'Layout: nudge viewports with arrow keys', kind: 'feature', eligibility, requesterEmail: 'ada@example.com', brief,
  requestUrl: 'https://linear.app/pushform/issue/FRQ-123', hostName: 'PushForm', maintainersAddress: 'support@pushform.io', ...extra,
});
const trial: TrialMailData = {
  url: 'https://frq-frq-123-layout-nudge.pushform-app.pages.dev', summary: 'Arrow keys now nudge the selected Layout viewport by 1 mm; Shift moves 10 mm.',
  leftOut: ['Nudging several viewports at once.'], expiresAt: '2026-10-26T12:00:00.000Z', now: '2026-10-23T12:30:00.000Z', round: 1,
  script: ['Open the sample Layout document from the feedback panel.', 'Select the viewport on page 1 and press Right.', 'Check that the viewport moved 1 mm to the right.'],
};
const trial2: TrialMailData = { ...trial, round: 2, now: '2026-10-25T09:00:00.000Z', addressed: ['Shift+arrow moved 100 mm instead of 10 mm.'], notAddressed: [{ item: 'Nudge with the numeric keypad.', reason: 'Outside the brief; filed as a follow-up idea.' }] };

describe('requester emails snapshots', () => {
  it('Filed for each eligibility', () => {
    for (const e of ['auto', 'gated', 'none'] as const) expect(filedMail(view(e))).toMatchSnapshot(`filed ${e}`);
    expect(filedMail(view('none', { kind: 'problem', brief: report, title: 'Push/pull by 0 mm removes the face' }))).toMatchSnapshot('filed problem report');
    expect(filedMail(view('gated', { brief: null }))).toMatchSnapshot('filed without brief');
  });
  it('Relayed comment, Withdrawn, Shipped', () => {
    expect(relayedCommentMail(view('gated'), 'Could you tell us which browser you used?\nA screenshot <helps>.')).toMatchSnapshot('relayed comment');
    expect(withdrawnMail(view('auto'))).toMatchSnapshot('withdrawn');
    expect(shippedMail(view('auto'))).toMatchSnapshot('shipped');
    expect(shippedMail(view('none'), '0.5.0')).toMatchSnapshot('shipped with version');
  });
  it('Ready to try, Updated trial, Reminder, Expired', () => {
    expect(readyToTryMail(view('auto'), trial)).toMatchSnapshot('ready to try');
    expect(updatedTrialMail(view('auto'), trial2)).toMatchSnapshot('updated trial');
    expect(updatedTrialMail(view('auto'), { ...trial, round: 2, leftOut: [], script: [] })).toMatchSnapshot('updated trial without lists');
    expect(reminderMail(view('gated'), { url: trial.url, expiresAt: trial.expiresAt, now: '2026-10-25T12:00:00.000Z' })).toMatchSnapshot('reminder');
    expect(expiredMail(view('gated'))).toMatchSnapshot('expired');
  });
});

describe('template contents', () => {
  it('Filed states what happens next per eligibility', () => {
    for (const eligibility of ['auto', 'gated', 'none'] as const) {
      expect(filedMail(view(eligibility)).text).toContain('The team will review your request in Linear');
      expect(filedMail(view(eligibility)).text).not.toMatch(/automatically|trial|Your requests/);
    }
    expect(whatHappensNext('gated', 'problem')).toContain('review your report');
    const text = filedMail(view('gated')).text;
    expect(text).toContain('FRQ-123');
    expect(text).toContain('Current workaround\n------------------\n\nNot provided');
    expect(text.indexOf('Problem\n')).toBeLessThan(text.indexOf('Desired behavior\n'));
  });
  it('Relayed comment says replies are not read and links the request page', () => {
    const mail = relayedCommentMail(view('gated'), 'Hello');
    expect(mail.text).toContain('Reply to support@pushform.io');
    expect(mail.text).not.toContain('/requests/');
    expect(mail.text).toContain('> Hello');
    // And: the one email never both forbids and invites an email reply.
    expect(mail.text).not.toContain('reply to support@pushform.io');
    expect(withdrawnMail(view('gated')).text).toContain('reply to support@pushform.io');
  });
  it('Ready to try carries every item', () => {
    const mail = readyToTryMail(view('auto'), trial);
    expect(mail.subject).toBe('[FRQ-123] Ready to try: Layout: nudge viewports with arrow keys');
    for (const needle of [trial.summary, 'Nudging several viewports at once.', trial.url, 'ada@example.com', 'separate trial data', '2026-10-26 12:00 UTC', '2 days and 23 hours from now', '24 hours after you give a verdict', '1. Open the sample Layout document', 'feedback panel inside the trial', 'support@pushform.io']) expect(mail.text).toContain(needle);
  });
  it('Updated trial lists addressed and not addressed items', () => {
    const text = updatedTrialMail(view('auto'), trial2).text;
    expect(text).toContain('- Addressed: Shift+arrow moved 100 mm instead of 10 mm.');
    expect(text).toContain('- Not addressed: Nudge with the numeric keypad. (Outside the brief; filed as a follow-up idea.)');
    expect(text).toContain('Round: 2');
  });
  it('escapes HTML and keeps the text plain', () => {
    const mail = filedMail(view('none', { brief: report, kind: 'problem' }));
    expect(mail.html).toContain('The face disappears &amp; the &lt;model&gt; breaks.');
    expect(mail.html).not.toContain('<model>');
    expect(mail.text).toContain('The face disappears & the <model> breaks.');
    expect(mail.html.startsWith('<!doctype html>')).toBe(true);
    expect(mail.html).toContain('<title>[FRQ-123] Filed: Layout: nudge viewports with arrow keys</title>');
  });
  it('formats UTC times and remaining durations', () => {
    expect(formatUtc('2026-10-26T12:00:00.000Z')).toBe('2026-10-26 12:00 UTC');
    expect(formatRemaining('2026-10-23T12:30:00Z', '2026-10-26T12:00:00Z')).toBe('2 days and 23 hours');
    expect(formatRemaining('2026-10-26T11:00:00Z', '2026-10-26T12:00:00Z')).toBe('1 hour');
    expect(formatRemaining('2026-10-25T12:00:00Z', '2026-10-26T12:00:00Z')).toBe('1 day');
    expect(formatRemaining('2026-10-26T11:30:00Z', '2026-10-26T12:00:00Z')).toBe('less than an hour');
    expect(formatRemaining('2026-10-26T13:00:00Z', '2026-10-26T12:00:00Z')).toBe('expired');
  });
  it('renderMail dispatches every template and receivesTemplate follows eligibility', () => {
    const payloads: MailTemplatePayload[] = [
      { template: 'filed' }, { template: 'relayed_comment', body: 'x' }, { template: 'ready_to_try', trial }, { template: 'updated_trial', trial: trial2 },
      { template: 'reminder', trial }, { template: 'expired' }, { template: 'withdrawn' }, { template: 'shipped', version: '1.0' },
    ];
    expect(payloads.map(p => p.template)).toEqual([...MAIL_TEMPLATES]);
    for (const payload of payloads) {
      const mail = renderMail(view('auto'), payload);
      expect(mail.subject.startsWith('[FRQ-123] ')).toBe(true);
      expect(mail.text.length).toBeGreaterThan(50);
    }
    expect(MAIL_TEMPLATES.filter(t => receivesTemplate('none', t))).toEqual(['filed', 'relayed_comment', 'withdrawn', 'shipped']);
    expect(MAIL_TEMPLATES.every(t => receivesTemplate('auto', t) && receivesTemplate('gated', t))).toBe(true);
  });
});
