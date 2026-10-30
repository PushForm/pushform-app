// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/load.ts';
import { SAMPLE_CONFIG_INPUT } from '../config/sample.ts';
import { areaLabel, branchName, branchSlug, classLabel, isPipelineBranch, issueBody, issueLabels, issueSections, issueTitle, parseAreaLabel, parseClassLabel, transcriptUrl, withClassLabels, type IssueRequestDetails } from './issue.ts';
import { emptyFeatureBrief, emptyProblemReport, type FeatureBrief, type ProblemReport } from './types.ts';

const config = loadConfig(SAMPLE_CONFIG_INPUT);
const details: IssueRequestDetails = {
  requesterEmail: 'ada@example.com', accountId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', orgId: null, host: 'pushform',
  clientVersion: '0.4.2', clientBuild: 'abc1234', requestId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', backendUrl: 'https://x.supabase.co/functions/v1/fr-conversation/',
};
const feature: FeatureBrief = {
  kind: 'ux-change', problem: 'I cannot move a Layout viewport with the keyboard.', workaround: null, desired: 'Arrow keys nudge the selected viewport by 1 mm.',
  acceptance: ['When I select a viewport and press Right, then it moves 1 mm right.'], mustNotChange: 'Arrow keys keep scrolling the page when nothing is selected.',
  area: 'Layout', importance: { level: 'important', reason: 'Precise placement is slow with the mouse.' }, estimatedClass: 'C3',
};
const problem: ProblemReport = {
  kind: 'problem', steps: ['Open a model', 'Push/pull a face by 0 mm'], expected: 'Nothing changes.', happened: 'The face disappears.', frequency: 'always',
  area: 'Modeling', impact: 'cannot_work', estimatedClass: 'C3', environment: { build: '0.4.2 (abc1234)', browser: 'Firefox 150', os: 'macOS 26', documentType: 'model', at: '2026-10-23T10:00:00.000Z' },
};

describe('issueTitle', () => {
  it('collapses whitespace and keeps short titles', () => { expect(issueTitle('  Move   viewports\nwith arrows ')).toBe('Move viewports with arrows'); });
  it('cuts at a word boundary to at most 80 characters', () => {
    const long = 'A '.repeat(30) + 'very long title that keeps going well beyond the limit of eighty characters';
    const title = issueTitle(long);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/ …$/);
    expect(issueTitle('x'.repeat(100)).length).toBe(80);
  });
  it('falls back for empty input', () => { expect(issueTitle('   ')).toBe('Untitled request'); });
});

describe('issueBody', () => {
  it('renders feature sections in order with Not provided and the request details', () => {
    const body = issueBody(feature, details);
    const headings = [...body.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    expect(headings).toEqual(['Kind', 'Problem', 'Current workaround', 'Desired behavior', 'Acceptance examples', 'Must not change', 'Area', 'Importance', 'Request details']);
    expect(body).toContain('## Current workaround\n\nNot provided');
    expect(body).toContain('## Kind\n\nUX change');
    expect(body).toContain('Important: Precise placement is slow with the mouse.');
    expect(body).toContain('- Requester: ada@example.com');
    expect(body).toContain('- Account: 7c9e6679-7425-40de-944b-e07fc1f90ae7');
    expect(body).toContain('- Scope: global');
    expect(body).toContain('- Host: pushform');
    expect(body).toContain('- Client: 0.4.2 (abc1234)');
    expect(body).toContain('- Transcript: https://x.supabase.co/functions/v1/fr-conversation/requests/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    expect(body.endsWith('\n')).toBe(true);
  });
  it('renders problem sections in order with the environment before the class', () => {
    const body = issueBody(problem, { ...details, orgId: 'org-1' });
    const headings = [...body.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    expect(headings).toEqual(['What I did', 'What I expected', 'What happened', 'How often', 'Area', 'Impact', 'Environment', 'Request details']);
    expect(body).toContain('1. Open a model\n2. Push/pull a face by 0 mm');
    expect(body).toContain('Impact\n\nCannot work');
    expect(body).toContain('Browser: Firefox 150');
    expect(body).toContain('- Scope: org-1');
  });
  it('renders every skipped section as Not provided', () => {
    const sections = issueSections(emptyFeatureBrief());
    expect(sections.filter(([h]) => h !== 'Kind').every(([, body]) => body === 'Not provided')).toBe(true);
    const report = issueSections(emptyProblemReport({ build: '', browser: '', os: '', documentType: '', at: '' }));
    expect(report.find(([h]) => h === 'What I did')?.[1]).toBe('Not provided');
    expect(report.find(([h]) => h === 'Environment')?.[1]).toContain('Build: Not provided');
    expect(report.find(([h]) => h === 'Environment')?.[1]).toContain('Document type: none');
  });
  it('builds the transcript link without duplicate slashes', () => {
    expect(transcriptUrl('https://b.example', 'r1')).toBe('https://b.example/requests/r1');
  });
});

describe('issueLabels', () => {
  it('lists kind, area, source, class and eligibility', () => {
    expect(issueLabels(feature, 'gated', config)).toEqual(['ux-change', 'area:layout', 'source:in-app']);
    expect(issueLabels({ ...feature, kind: 'feature', area: null, estimatedClass: null }, 'none', config)).toEqual(['feature', 'source:in-app']);
  });
  it('uses the configured problem label', () => {
    expect(issueLabels(problem, 'auto', config)[0]).toBe('defect');
    const custom = loadConfig({ ...SAMPLE_CONFIG_INPUT, tracker: { ...SAMPLE_CONFIG_INPUT.tracker, problemDestination: { label: 'bug' } } });
    expect(issueLabels(problem, 'auto', custom)[0]).toBe('bug');
  });
  it('replaces the class and eligibility labels and keeps the rest', () => {
    expect(withClassLabels(['defect', 'area:modeling', 'source:in-app', 'class:C3', 'eligible:auto'], 'C5', 'gated')).toEqual(['defect', 'area:modeling', 'source:in-app', 'class:C5', 'eligible:gated']);
    expect(withClassLabels(['feature'], null, 'none')).toEqual(['feature', 'eligible:none']);
  });
  it('parses labels', () => {
    expect(parseClassLabel('class:C6')).toBe('C6');
    expect(parseClassLabel('class:C9')).toBeNull();
    expect(parseAreaLabel(areaLabel('Cloud'))).toBe('Cloud');
    expect(parseAreaLabel('area:space')).toBeNull();
    expect(classLabel('C2')).toBe('class:C2');
  });
});

describe('branch names', () => {
  it('slugs titles to lowercase hyphens of at most 40 characters', () => {
    expect(branchSlug('Layout: Move tool!')).toBe('layout-move-tool');
    expect(branchSlug('Éviter les accents — déjà vu')).toBe('eviter-les-accents-deja-vu');
    const slug = branchSlug('Make the push pull tool keep faces coplanar when extruding across groups');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe('make-the-push-pull-tool-keep-faces');
    expect(branchSlug('!!!')).toBe('request');
    expect(branchSlug('a'.repeat(50))).toBe('a'.repeat(40));
  });
  it('composes prefix, UTC date, 8 id characters and slug', () => {
    const name = branchName('frq', new Date('2026-10-23T23:59:00Z'), 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', 'Layout move tool');
    expect(name).toBe('frq/2026-10-23/a1b2c3d4/layout-move-tool');
    expect(isPipelineBranch('frq', name)).toBe(true);
    expect(isPipelineBranch('frq', 'frqx/2026-10-23/a/b')).toBe(false);
    expect(isPipelineBranch('frq', 'main')).toBe(false);
  });
});
