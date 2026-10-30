// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { briefSections, NOT_PROVIDED } from '../agents/brief.ts';
import { eligibilityLabel } from './eligibility.ts';
import type { Config } from '../config/schema.ts';
import { AREAS, type Area, type Brief, type ChangeClass, type Eligibility, type Kind } from './types.ts';

export const ISSUE_TITLE_MAX = 80;
export const BRANCH_SLUG_MAX = 40;

/** Collapse whitespace and cut to 80 characters at a word boundary. */
export function issueTitle(proposed: string, fallback = 'Untitled request'): string {
  const text = proposed.replace(/\s+/g, ' ').trim() || fallback;
  if (text.length <= ISSUE_TITLE_MAX) return text;
  const cut = text.slice(0, ISSUE_TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > ISSUE_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Sections of the issue body as `[heading, body]` pairs: the brief's sections in
 * order (from `agents/brief.ts`), plus the environment the panel recorded for a problem report.
 */
export function issueSections(brief: Brief): [string, string][] {
  const sections = briefSections(brief).map(s => [s.heading, s.text] as [string, string]);
  if (brief.kind !== 'problem') return sections;
  const env = brief.environment;
  const environment: [string, string] = ['Environment', [
    `Build: ${env.build || NOT_PROVIDED}`, `Browser: ${env.browser || NOT_PROVIDED}`, `OS: ${env.os || NOT_PROVIDED}`,
    `Document type: ${env.documentType || 'none'}`, `Time: ${env.at || NOT_PROVIDED}`,
  ].join('\n')];
  const at = sections.findIndex(([heading]) => heading === 'Estimated change class');
  return at < 0 ? [...sections, environment] : [...sections.slice(0, at), environment, ...sections.slice(at)];
}

/** Request details appended to the body. */
export interface IssueRequestDetails {
  requesterEmail: string;
  accountId: string;
  /** Organization id, or null for the global scope. */
  orgId: string | null;
  host: string;
  clientVersion: string;
  clientBuild: string;
  /** Pipeline request id; the transcript link is `<backendUrl>/requests/<requestId>`. */
  requestId: string;
  backendUrl: string;
}
export function transcriptUrl(backendUrl: string, requestId: string): string { return `${backendUrl.replace(/\/+$/, '')}/requests/${requestId}`; }
export function issueBody(brief: Brief, details: IssueRequestDetails): string {
  const sections = issueSections(brief).map(([heading, body]) => `## ${heading}\n\n${body}`);
  const meta = [
    `- Requester: ${details.requesterEmail}`,
    `- Account: ${details.accountId}`,
    `- Scope: ${details.orgId ?? 'global'}`,
    `- Host: ${details.host}`,
    `- Client: ${details.clientVersion} (${details.clientBuild})`,
    `- Transcript: ${transcriptUrl(details.backendUrl, details.requestId)}`,
  ];
  return [...sections, `## Request details\n\n${meta.join('\n')}`].join('\n\n') + '\n';
}

export function kindLabel(kind: Kind, config: Config): string { return kind === 'problem' ? config.tracker.problemDestination.label : kind; }
export function areaLabel(area: Area): string { return `area:${area.toLowerCase()}`; }
export function classLabel(cls: ChangeClass): `class:${ChangeClass}` { return `class:${cls}`; }
export function parseClassLabel(label: string): ChangeClass | null {
  const m = /^class:(C[1-7])$/.exec(label);
  return m ? (m[1] as ChangeClass) : null;
}
export function parseAreaLabel(label: string): Area | null {
  const m = /^area:(.+)$/.exec(label);
  return m ? (AREAS.find(a => a.toLowerCase() === m[1]!.toLowerCase()) ?? null) : null;
}
/** Labels: Kind or the problem label, Area, `source:in-app`, `class:C<n>`, `eligible:<...>`. */
export function issueLabels(brief: Brief, _eligibility: Eligibility, config: Config): string[] {
  const labels = [kindLabel(brief.kind, config)];
  if (brief.area) labels.push(areaLabel(brief.area));
  labels.push('source:in-app');
  return labels;
}
/** Replace the class and eligibility labels, keeping every other label. */
export function withClassLabels(labels: readonly string[], cls: ChangeClass | null, eligibility: Eligibility): string[] {
  const kept = labels.filter(l => parseClassLabel(l) === null && !/^eligible:/.test(l));
  return [...kept, ...(cls ? [classLabel(cls)] : []), eligibilityLabel(eligibility)];
}

/** Lowercase hyphenated description of at most 40 characters taken from the title. */
export function branchSlug(title: string): string {
  const slug = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return 'request';
  if (slug.length <= BRANCH_SLUG_MAX) return slug;
  const cut = slug.slice(0, BRANCH_SLUG_MAX);
  const hyphen = cut.lastIndexOf('-');
  return (hyphen > BRANCH_SLUG_MAX / 2 ? cut.slice(0, hyphen) : cut).replace(/-+$/, '');
}
/** `<prefix>/<YYYY-MM-DD>/<first 8 of request id>/<slug>`; `firstRunAt` is the UTC date of the first run. */
export function branchName(prefix: string, firstRunAt: Date, requestId: string, title: string): string {
  const date = firstRunAt.toISOString().slice(0, 10);
  return `${prefix}/${date}/${requestId.replace(/-/g, '').slice(0, 8)}/${branchSlug(title)}`;
}
export function isPipelineBranch(prefix: string, branch: string): boolean { return branch.startsWith(`${prefix}/`); }
