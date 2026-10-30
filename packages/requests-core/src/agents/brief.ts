// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';

/** Conversation paths and the brief kinds they produce. */
export type Path = 'help' | 'problem' | 'feature';
/** A conversation's stored path: one of the three agent paths, or `open` until the requester's first message settles it. */
export type ConversationPath = Path | 'open';
export type Kind = 'feature' | 'ux-change' | 'problem';
export type Area = 'Modeling' | 'Layout' | 'Cloud' | 'Shell';
export type ChangeClass = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7';
export type ImportanceLevel = 'nice' | 'important' | 'blocking';
export type Frequency = 'always' | 'sometimes' | 'once';
export type Impact = 'cannot_work' | 'workaround' | 'cosmetic';
export const AREAS: readonly Area[] = ['Modeling', 'Layout', 'Cloud', 'Shell'];
export const CHANGE_CLASSES: readonly ChangeClass[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];

/** The feature or UX change brief, sections in order. Null sections render as "Not provided". */
export interface FeatureBrief {
  kind: 'feature' | 'ux-change';
  problem: string | null;
  workaround: string | null;
  desired: string | null;
  acceptance: string[];
  mustNotChange: string | null;
  area: Area | null;
  importance: { level: ImportanceLevel; reason: string } | null;
  estimatedClass: ChangeClass | null;
}
/** Environment the panel adds to a problem report; never asked of the requester. */
export interface ReportEnvironment { build: string; browser: string; os: string; documentType: string; at: string }
/** The problem report, sections in order. */
export interface ProblemReport {
  kind: 'problem';
  steps: string[];
  expected: string | null;
  happened: string | null;
  frequency: Frequency | null;
  area: Area | null;
  impact: Impact | null;
  estimatedClass: ChangeClass | null;
  environment: ReportEnvironment;
}
export type Brief = FeatureBrief | ProblemReport;

export const NOT_PROVIDED = 'Not provided';
export const TITLE_LIMIT = 80;
/** Free-text sections the requester may set through the chat; `estimatedClass` is agent-only. */
export type FeatureTextSection = 'problem' | 'workaround' | 'desired' | 'acceptance' | 'mustNotChange' | 'importanceReason';
export type ProblemTextSection = 'steps' | 'expected' | 'happened';
export type TextSection = FeatureTextSection | ProblemTextSection;
/** Fixed-choice sections. */
export type ChoiceSection = 'kind' | 'area' | 'importance' | 'frequency' | 'impact';
export const FEATURE_TEXT_SECTIONS: readonly FeatureTextSection[] = ['problem', 'workaround', 'desired', 'acceptance', 'mustNotChange', 'importanceReason'];
export const PROBLEM_TEXT_SECTIONS: readonly ProblemTextSection[] = ['steps', 'expected', 'happened'];

const area = z.enum(['Modeling', 'Layout', 'Cloud', 'Shell']);
const changeClass = z.enum(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']);
/** Size bounds of a brief: a section is at most SECTION_MAX characters and a list holds at most LIST_MAX entries, so a brief
 * always fits the 64 KB column check of `fr_conversations.brief`/`fr_requests.brief`, every email payload and the issue body. */
export const SECTION_MAX = 4000;
export const LIST_MAX = 50;
const section = z.string().max(SECTION_MAX);
const list = z.array(z.string().max(1000)).max(LIST_MAX);
const short = z.string().max(200);
export const featureBriefSchema = z.object({
  kind: z.enum(['feature', 'ux-change']),
  problem: section.nullable(), workaround: section.nullable(), desired: section.nullable(),
  acceptance: list, mustNotChange: section.nullable(), area: area.nullable(),
  importance: z.object({ level: z.enum(['nice', 'important', 'blocking']), reason: z.string().max(2000) }).nullable(),
  estimatedClass: changeClass.nullable(),
});
export const problemReportSchema = z.object({
  kind: z.literal('problem'),
  steps: list, expected: section.nullable(), happened: section.nullable(),
  frequency: z.enum(['always', 'sometimes', 'once']).nullable(), area: area.nullable(),
  impact: z.enum(['cannot_work', 'workaround', 'cosmetic']).nullable(), estimatedClass: changeClass.nullable(),
  environment: z.object({ build: short, browser: short, os: short, documentType: short, at: short }),
});
export const briefSchema = z.discriminatedUnion('kind', [featureBriefSchema, problemReportSchema]);
export function parseBrief(value: unknown): Brief | null { const r = briefSchema.safeParse(value); return r.success ? r.data : null; }

export function emptyFeatureBrief(kind: 'feature' | 'ux-change' = 'feature'): FeatureBrief {
  return { kind, problem: null, workaround: null, desired: null, acceptance: [], mustNotChange: null, area: null, importance: null, estimatedClass: null };
}
export function emptyProblemReport(environment: ReportEnvironment): ProblemReport {
  return { kind: 'problem', steps: [], expected: null, happened: null, frequency: null, area: null, impact: null, estimatedClass: null, environment };
}
/** The brief a path starts with; the help path has none, and neither has a conversation whose path is still open. */
export function emptyBriefFor(path: ConversationPath, environment: ReportEnvironment): Brief | null {
  return path === 'feature' ? emptyFeatureBrief() : path === 'problem' ? emptyProblemReport(environment) : null;
}
export function pathOf(brief: Brief): Path { return brief.kind === 'problem' ? 'problem' : 'feature'; }

/** Acceptance examples take the form "When I ..., then ...". */
export const ACCEPTANCE_PATTERN = /^when\s+(?:i|the|a|an)\b.+?,\s*then\s+.+$/i;
export function isAcceptanceExample(text: string): boolean { return ACCEPTANCE_PATTERN.test(text.trim()); }

const clean = (s: string | null | undefined): string | null => { const t = (s ?? '').trim(); return t.length ? t : null; };
/** Lines of a list section: numbered or bulleted prefixes removed, blanks dropped. */
export function splitList(text: string | null): string[] {
  return (text ?? '').split(/\r?\n/).map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim()).filter((l) => l.length > 0);
}

export interface SectionUpdateError { ok: false; message: string }
export interface SectionUpdateOk<B extends Brief> { ok: true; brief: B }
/**
 * Set one free-text section from the requester's words. `text` null clears the section.
 * Acceptance examples are validated line by line; the requester's wording is kept otherwise.
 */
export function setTextSection(brief: Brief, section: TextSection, text: string | null): SectionUpdateOk<Brief> | SectionUpdateError {
  const value = clean(text);
  if (brief.kind === 'problem') {
    if (section === 'steps') return { ok: true, brief: { ...brief, steps: splitList(value) } };
    if (section === 'expected' || section === 'happened') return { ok: true, brief: { ...brief, [section]: value } };
    return { ok: false, message: `Section "${section}" does not exist on a problem report. Sections: ${PROBLEM_TEXT_SECTIONS.join(', ')}.` };
  }
  switch (section) {
    case 'problem': case 'workaround': case 'desired': case 'mustNotChange': return { ok: true, brief: { ...brief, [section]: value } };
    case 'acceptance': {
      const lines = splitList(value);
      const bad = lines.filter((l) => !isAcceptanceExample(l));
      if (bad.length) return { ok: false, message: `Acceptance examples must read "When I ..., then ...". Rephrase with the requester: ${bad.map((b) => JSON.stringify(b)).join('; ')}` };
      return { ok: true, brief: { ...brief, acceptance: lines } };
    }
    case 'importanceReason':
      if (!brief.importance) return { ok: false, message: 'Set the importance level first (nice, important or blocking), then its reason.' };
      return { ok: true, brief: { ...brief, importance: { ...brief.importance, reason: value ?? '' } } };
    default: return { ok: false, message: `Section "${section}" does not exist on a feature brief. Sections: ${FEATURE_TEXT_SECTIONS.join(', ')}.` };
  }
}
/** Set a fixed-choice section; `choice` null clears it. Importance keeps its reason when only the level changes. */
export function setChoiceSection(brief: Brief, section: ChoiceSection, choice: string | null): SectionUpdateOk<Brief> | SectionUpdateError {
  const bad = (options: readonly string[]) => ({ ok: false as const, message: `"${choice}" is not a valid ${section}. Options: ${options.join(', ')}.` });
  if (section === 'area') { if (choice === null) return { ok: true, brief: { ...brief, area: null } }; return (AREAS as readonly string[]).includes(choice) ? { ok: true, brief: { ...brief, area: choice as Area } } : bad(AREAS); }
  if (brief.kind === 'problem') {
    if (section === 'frequency') { const o = ['always', 'sometimes', 'once']; return choice === null || o.includes(choice) ? { ok: true, brief: { ...brief, frequency: choice as Frequency | null } } : bad(o); }
    if (section === 'impact') { const o = ['cannot_work', 'workaround', 'cosmetic']; return choice === null || o.includes(choice) ? { ok: true, brief: { ...brief, impact: choice as Impact | null } } : bad(o); }
    return { ok: false, message: `Section "${section}" does not exist on a problem report. Choice sections: area, frequency, impact.` };
  }
  if (section === 'kind') { const o = ['feature', 'ux-change']; return choice !== null && o.includes(choice) ? { ok: true, brief: { ...brief, kind: choice as 'feature' | 'ux-change' } } : bad(o); }
  if (section === 'importance') {
    const o = ['nice', 'important', 'blocking'];
    if (choice === null) return { ok: true, brief: { ...brief, importance: null } };
    return o.includes(choice) ? { ok: true, brief: { ...brief, importance: { level: choice as ImportanceLevel, reason: brief.importance?.reason ?? '' } } } : bad(o);
  }
  return { ok: false, message: `Section "${section}" does not exist on a feature brief. Choice sections: kind, area, importance.` };
}
export function setEstimatedClass(brief: Brief, estimatedClass: ChangeClass): Brief { return { ...brief, estimatedClass }; }

/**
 * Carry answers over when the path switches. Problem -> feature: the steps and what happened become the
 * Problem, what was expected becomes Desired behavior. Feature -> problem: Problem becomes What happened, Desired
 * becomes What I expected. Area and class always carry. Importance and Impact do not: they are different questions
 * with different answers, and a derived value would be content the requester never gave, so the agent asks.
 */
export function carryOver(brief: Brief | null, to: Path, environment: ReportEnvironment): Brief | null {
  if (to === 'help') return null;
  if (!brief) return emptyBriefFor(to, environment);
  if (pathOf(brief) === to) return brief;
  if (brief.kind === 'problem') {
    const context = [brief.steps.length ? `Steps: ${brief.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}` : null, brief.happened ? `What happened: ${brief.happened}` : null].filter((x): x is string => x !== null);
    return {
      ...emptyFeatureBrief('feature'), problem: context.length ? context.join('\n') : null, desired: brief.expected, area: brief.area,
      importance: null, estimatedClass: brief.estimatedClass,
    };
  }
  return {
    ...emptyProblemReport(environment), happened: brief.problem, expected: brief.desired, area: brief.area,
    impact: null, estimatedClass: brief.estimatedClass,
  };
}

/** Why a brief cannot be filed; `null` when it can. */
export type DeclineReason = 'abusive' | 'off_topic' | 'empty';
export const DECLINE_MESSAGES: Record<DeclineReason, string> = {
  abusive: 'I cannot file this because the content is abusive.',
  off_topic: 'I cannot file this because it has nothing to do with the product.',
  empty: 'I cannot file this yet because neither the problem nor the desired behavior has been provided.',
};
export interface Completeness { fileable: boolean; reason: DeclineReason | null; missing: string[] }
/** Filing needs Problem or Desired behavior (for a report: What happened or What I expected). */
export function completeness(brief: Brief | null): Completeness {
  if (!brief) return { fileable: false, reason: 'empty', missing: ['Problem', 'Desired behavior'] };
  const missing: string[] = [];
  if (brief.kind === 'problem') {
    if (!brief.steps.length) missing.push('What I did');
    if (!brief.expected) missing.push('What I expected');
    if (!brief.happened) missing.push('What happened');
    if (!brief.frequency) missing.push('How often');
    if (!brief.area) missing.push('Area');
    if (!brief.impact) missing.push('Impact');
    return { fileable: !!(brief.happened || brief.expected), reason: brief.happened || brief.expected ? null : 'empty', missing };
  }
  if (!brief.problem) missing.push('Problem');
  if (!brief.workaround) missing.push('Current workaround');
  if (!brief.desired) missing.push('Desired behavior');
  if (!brief.acceptance.length) missing.push('Acceptance examples');
  if (!brief.mustNotChange) missing.push('Must not change');
  if (!brief.area) missing.push('Area');
  if (!brief.importance) missing.push('Importance');
  const fileable = !!(brief.problem || brief.desired);
  return { fileable, reason: fileable ? null : 'empty', missing };
}

const IMPORTANCE_LABEL: Record<ImportanceLevel, string> = { nice: 'Nice to have', important: 'Important', blocking: 'Blocking' };
const IMPACT_LABEL: Record<Impact, string> = { cannot_work: 'Cannot work', workaround: 'Workaround exists', cosmetic: 'Cosmetic' };
const FREQUENCY_LABEL: Record<Frequency, string> = { always: 'Always', sometimes: 'Sometimes', once: 'Once' };
export const KIND_LABEL: Record<Kind, string> = { feature: 'Feature', 'ux-change': 'UX change', problem: 'Problem' };
export interface BriefSection { heading: string; text: string; provided: boolean }
/** Sections in order with "Not provided" placeholders; shared by the panel preview and the issue body. */
export function briefSections(brief: Brief): BriefSection[] {
  const text = (v: string | null, f: (s: string) => string = (s) => s): BriefSection['text'] => (v === null ? NOT_PROVIDED : f(v));
  const list = (items: string[], numbered: boolean) => items.length ? items.map((s, i) => (numbered ? `${i + 1}. ${s}` : `- ${s}`)).join('\n') : NOT_PROVIDED;
  const sec = (heading: string, t: string): BriefSection => ({ heading, text: t, provided: t !== NOT_PROVIDED });
  if (brief.kind === 'problem') {
    return [
      sec('What I did', list(brief.steps, true)), sec('What I expected', text(brief.expected)), sec('What happened', text(brief.happened)),
      sec('How often', text(brief.frequency, (f) => FREQUENCY_LABEL[f as Frequency])), sec('Area', text(brief.area)),
      sec('Impact', text(brief.impact, (i) => IMPACT_LABEL[i as Impact])),
    ];
  }
  return [
    sec('Kind', KIND_LABEL[brief.kind]), sec('Problem', text(brief.problem)), sec('Current workaround', text(brief.workaround)),
    sec('Desired behavior', text(brief.desired)), sec('Acceptance examples', list(brief.acceptance, false)), sec('Must not change', text(brief.mustNotChange)),
    sec('Area', text(brief.area)),
    sec('Importance', brief.importance ? `${IMPORTANCE_LABEL[brief.importance.level]}${brief.importance.reason ? `: ${brief.importance.reason}` : ''}` : NOT_PROVIDED),
  ];
}
/** Markdown for the panel's brief preview and the model's view of the current brief. */
export function renderBriefMarkdown(brief: Brief, title?: string | null): string {
  const head = title ? `# ${title}\n\n` : '';
  return head + briefSections(brief).map((s) => `## ${s.heading}\n${s.text}`).join('\n\n');
}
/** Propose-title validation: one line, at most 80 characters. */
export function validateTitle(title: string): { ok: true; title: string } | { ok: false; message: string } {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, message: 'The title is empty.' };
  if (t.length > TITLE_LIMIT) return { ok: false, message: `The title has ${t.length} characters; the limit is ${TITLE_LIMIT}. Shorten it.` };
  return { ok: true, title: t };
}
