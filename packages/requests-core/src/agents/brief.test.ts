// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import {
  NOT_PROVIDED, carryOver, completeness, emptyFeatureBrief, emptyProblemReport, isAcceptanceExample, parseBrief, renderBriefMarkdown,
  setChoiceSection, setTextSection, splitList, validateTitle, type ProblemReport, type ReportEnvironment,
} from './brief.ts';

const env: ReportEnvironment = { build: '0.3.0 (abc123)', browser: 'Chrome 141', os: 'macOS 15', documentType: 'model', at: '2026-10-23T10:00:00Z' };

describe('brief sections', () => {
  it('renders every missing section as "Not provided" in order', () => {
    const md = renderBriefMarkdown(emptyFeatureBrief('ux-change'));
    const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(['Kind', 'Problem', 'Current workaround', 'Desired behavior', 'Acceptance examples', 'Must not change', 'Area', 'Importance']);
    expect(md).toContain('## Kind\nUX change');
    expect(md.match(new RegExp(NOT_PROVIDED, 'g'))).toHaveLength(7);
  });
  it('renders a report in order with numbered steps and a title', () => {
    const r: ProblemReport = { ...emptyProblemReport(env), steps: ['Open a model', 'Press P'], frequency: 'sometimes', impact: 'workaround' };
    const md = renderBriefMarkdown(r, 'Push/Pull stalls');
    expect(md.startsWith('# Push/Pull stalls\n\n## What I did\n1. Open a model\n2. Press P')).toBe(true);
    expect([...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['What I did', 'What I expected', 'What happened', 'How often', 'Area', 'Impact']);
    expect(md).toContain('## How often\nSometimes'); expect(md).toContain('## Impact\nWorkaround exists');
  });
  it('sets text sections and validates acceptance examples', () => {
    let b = emptyFeatureBrief();
    const bad = setTextSection(b, 'acceptance', 'It should just work');
    expect(bad.ok).toBe(false);
    const ok = setTextSection(b, 'acceptance', '- When I press P on a face, then the face extrudes\n2. When I type 10, then it moves 10 cm');
    expect(ok.ok && ok.brief.kind !== 'problem' && ok.brief.acceptance).toEqual(['When I press P on a face, then the face extrudes', 'When I type 10, then it moves 10 cm']);
    b = (setTextSection(b, 'problem', '  I cannot copy a face  ') as { ok: true; brief: typeof b }).brief;
    expect(b.problem).toBe('I cannot copy a face');
    expect((setTextSection(b, 'problem', '   ') as { ok: true; brief: typeof b }).brief.problem).toBeNull();
    expect(setTextSection(b, 'steps', 'x').ok).toBe(false);
    expect(setTextSection(b, 'importanceReason', 'x').ok).toBe(false);
  });
  it('sets choice sections with validation and keeps the importance reason', () => {
    let b = emptyFeatureBrief();
    expect(setChoiceSection(b, 'area', 'Kitchen').ok).toBe(false);
    b = (setChoiceSection(b, 'importance', 'blocking') as { ok: true; brief: typeof b }).brief;
    b = (setTextSection(b, 'importanceReason', 'ships block') as { ok: true; brief: typeof b }).brief;
    b = (setChoiceSection(b, 'importance', 'important') as { ok: true; brief: typeof b }).brief;
    expect(b.importance).toEqual({ level: 'important', reason: 'ships block' });
    expect(setChoiceSection(b, 'kind', null).ok).toBe(false);
    expect(setChoiceSection(b, 'frequency', 'always').ok).toBe(false);
    const r = emptyProblemReport(env);
    expect(setChoiceSection(r, 'impact', 'cosmetic')).toMatchObject({ ok: true, brief: { impact: 'cosmetic' } });
    expect(setChoiceSection(r, 'kind', 'feature').ok).toBe(false);
  });
  it('recognises acceptance examples and splits lists', () => {
    expect(isAcceptanceExample('When I click Save, then the file is stored')).toBe(true);
    expect(isAcceptanceExample('when the model opens, then the camera fits')).toBe(true);
    expect(isAcceptanceExample('Then it works')).toBe(false);
    expect(splitList('1. a\n\n- b\n• c\n')).toEqual(['a', 'b', 'c']);
  });
});

describe('carryOver', () => {
  it('maps a report onto a feature brief: steps and happened become the problem, expected the desired behavior', () => {
    const r: ProblemReport = { ...emptyProblemReport(env), steps: ['Open Layout', 'Insert a table'], expected: 'A table with borders', happened: 'No borders appear', area: 'Layout', impact: 'cannot_work', estimatedClass: 'C3', frequency: 'always' };
    const f = carryOver(r, 'feature', env);
    expect(f?.kind).toBe('feature');
    if (!f || f.kind === 'problem') throw new Error('expected feature brief');
    expect(f.problem).toBe('Steps: 1. Open Layout 2. Insert a table\nWhat happened: No borders appear');
    expect(f.desired).toBe('A table with borders'); expect(f.area).toBe('Layout'); expect(f.estimatedClass).toBe('C3');
    expect(f.importance).toBeNull(); expect(f.acceptance).toEqual([]); // Importance is a different question
  });
  it('maps a feature brief onto a report: problem becomes happened, desired becomes expected, importance becomes impact', () => {
    const f = { ...emptyFeatureBrief(), problem: 'Cannot lock inference', desired: 'Shift locks it', area: 'Modeling' as const, importance: { level: 'nice' as const, reason: 'r' }, estimatedClass: 'C4' as const };
    const r = carryOver(f, 'problem', env);
    expect(r).toMatchObject({ kind: 'problem', happened: 'Cannot lock inference', expected: 'Shift locks it', area: 'Modeling', impact: null, estimatedClass: 'C4', environment: env, steps: [] });
  });
  it('keeps the brief on the same path, drops it for help, and starts empty from nothing', () => {
    const f = emptyFeatureBrief();
    expect(carryOver(f, 'feature', env)).toBe(f);
    expect(carryOver(f, 'help', env)).toBeNull();
    expect(carryOver(null, 'problem', env)).toMatchObject({ kind: 'problem', environment: env });
  });
});

describe('completeness and titles', () => {
  it('needs Problem or Desired behavior to file, and lists what is still missing', () => {
    expect(completeness(null)).toMatchObject({ fileable: false, reason: 'empty' });
    expect(completeness(emptyFeatureBrief())).toMatchObject({ fileable: false, reason: 'empty' });
    const c = completeness({ ...emptyFeatureBrief(), desired: 'x' });
    expect(c.fileable).toBe(true); expect(c.reason).toBeNull();
    expect(c.missing).toEqual(['Problem', 'Current workaround', 'Acceptance examples', 'Must not change', 'Area', 'Importance']);
    expect(completeness(emptyProblemReport(env)).fileable).toBe(false);
    expect(completeness({ ...emptyProblemReport(env), happened: 'crash' }).fileable).toBe(true);
  });
  it('validates titles at 80 characters', () => {
    expect(validateTitle('  Lock   inference with Shift ')).toEqual({ ok: true, title: 'Lock inference with Shift' });
    expect(validateTitle('x'.repeat(81)).ok).toBe(false); expect(validateTitle(' ').ok).toBe(false);
  });
  it('parses stored briefs and rejects malformed ones', () => {
    expect(parseBrief(emptyFeatureBrief())).toEqual(emptyFeatureBrief());
    expect(parseBrief(emptyProblemReport(env))?.kind).toBe('problem');
    expect(parseBrief({ kind: 'feature' })).toBeNull();
  });
  it('bounds every section so a brief always fits its column, emails and the issue body', () => {
    expect(parseBrief({ ...emptyFeatureBrief(), problem: 'x'.repeat(4000) })).not.toBeNull();
    expect(parseBrief({ ...emptyFeatureBrief(), problem: 'x'.repeat(4001) })).toBeNull();
    expect(parseBrief({ ...emptyFeatureBrief(), acceptance: Array.from({ length: 51 }, () => 'When I x, then y') })).toBeNull();
    expect(parseBrief({ ...emptyProblemReport(env), steps: ['s'.repeat(1001)] })).toBeNull();
    expect(parseBrief({ ...emptyProblemReport(env), environment: { ...env, browser: 'b'.repeat(201) } })).toBeNull();
  });
});
