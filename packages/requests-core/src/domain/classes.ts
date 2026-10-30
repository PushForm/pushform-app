// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { BoundariesConfig } from '../config/schema.ts';
import { CHANGE_CLASS_ORDER, type ChangeClass, type Treatment } from './types.ts';

/** The table. */
export const CHANGE_CLASS_TABLE: readonly { class: ChangeClass; name: string; covers: string }[] = [
  { class: 'C1', name: 'Content and copy', covers: 'User-visible text, labels, help text, templates, documentation.' },
  { class: 'C2', name: 'Presentation', covers: 'Layout, styling, icons, ordering of controls, keyboard shortcuts, theme.' },
  { class: 'C3', name: 'Existing feature behavior', covers: 'How an existing tool, command, dialog, or setting behaves, including validation and defaults.' },
  { class: 'C4', name: 'New feature in an area', covers: 'A new command, tool, dialog, or option within an existing area, with new specification entries.' },
  { class: 'C5', name: 'File format and data model', covers: 'Native document formats, cloud document metadata, database schema and migrations, import and export behavior.' },
  { class: 'C6', name: 'Platform and infrastructure', covers: 'Build configuration, CI and deployment workflows, dependency additions or upgrades, the desktop shell, performance infrastructure.' },
  { class: 'C7', name: 'Security and money', covers: 'Authentication and sessions, authorization policies and security definer functions, billing and entitlements, secrets handling.' },
];

export function classIndex(cls: ChangeClass): number { return CHANGE_CLASS_ORDER.indexOf(cls); }
export function compareClass(a: ChangeClass, b: ChangeClass): number { return classIndex(a) - classIndex(b); }
export function isClass(value: unknown): value is ChangeClass { return typeof value === 'string' && (CHANGE_CLASS_ORDER as readonly string[]).includes(value); }
export function className(cls: ChangeClass): string { return CHANGE_CLASS_TABLE[classIndex(cls)]?.name ?? cls; }
/** Highest class of a set, or null when empty (records the highest as the estimate). */
export function highestClass(classes: Iterable<ChangeClass>): ChangeClass | null {
  let best: ChangeClass | null = null;
  for (const cls of classes) if (best === null || compareClass(cls, best) > 0) best = cls;
  return best;
}
export function treatmentOf(boundaries: BoundariesConfig, cls: ChangeClass): Treatment { return boundaries.treatments[cls]; }
/** Highest class whose treatment is `allowed`; null when nothing is allowed (caps ceilings by it). */
export function highestAllowedClass(boundaries: BoundariesConfig): ChangeClass | null {
  return highestClass(CHANGE_CLASS_ORDER.filter(c => boundaries.treatments[c] === 'allowed'));
}

/**
 * Minimal glob matcher for path mappings: a double star spans directories when it fills a whole
 * segment (at the start, at the end, or between slashes) and is one `*` otherwise, `*` and `?` stay within one segment, `{a,b}` lists
 * alternatives and may nest. Patterns match whole paths; a pattern without a slash matches the basename
 * anywhere, like `.gitignore` rules. Unbalanced braces throw, so `globError` can report them at config time.
 */
/** Index of the `}` closing the `{` at `open`, honouring nested braces; -1 when unbalanced. */
function closingBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  return -1;
}
/** Top-level comma-separated alternatives of a brace body (`a,{b,c}` -> [`a`, `{b,c}`]). */
function splitAlternatives(body: string): string[] {
  const out: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') depth--;
    else if (body[i] === ',' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  out.push(body.slice(start));
  return out;
}
function globFragment(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '*') {
      if (src[i + 1] === '*') {
        const bounded = i === 0 || src[i - 1] === '/';
        i++;
        if (bounded && src[i + 1] === '/') { i++; out += '(?:.*/)?'; }
        else if (bounded && i + 1 === src.length) out += '.*';
        else out += '[^/]*';
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') {
      const end = closingBrace(src, i);
      if (end < 0) throw new Error(`glob pattern "${src}" has an unbalanced "{"`);
      out += `(?:${splitAlternatives(src.slice(i + 1, end)).map(globFragment).join('|')})`;
      i = end;
    } else if (ch === '}') throw new Error(`glob pattern "${src}" has an unbalanced "}"`);
    else out += /[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return out;
}
export function globToRegExp(pattern: string): RegExp {
  const src = pattern.replace(/^\.\//, '').replace(/^\//, '');
  return new RegExp(`^${src.includes('/') ? '' : '(?:.*/)?'}${globFragment(src)}$`);
}
/** Why a path mapping pattern cannot be compiled, or null when it can (used by the configuration schema). */
export function globError(pattern: string): string | null {
  try { globToRegExp(pattern); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
}
export function globMatch(pattern: string, path: string): boolean { return globToRegExp(pattern).test(path.replace(/^\.\//, '').replace(/^\//, '')); }

/**
 * Class of one changed path: the highest class whose mappings match; an unmapped path is
 * C3 when the file existed and C4 when the change adds it.
 */
export function classOfPath(boundaries: BoundariesConfig, path: string, added = false): ChangeClass {
  const matched = CHANGE_CLASS_ORDER.filter(cls => (boundaries.paths[cls] ?? []).some(p => globMatch(p, path)));
  return highestClass(matched) ?? (added ? 'C4' : 'C3');
}
/** Classes of a change set, each with the paths that gave it (for the design note of). */
export function classesOfPaths(boundaries: BoundariesConfig, paths: readonly { path: string; added?: boolean }[]): Map<ChangeClass, string[]> {
  const result = new Map<ChangeClass, string[]>();
  for (const { path, added } of paths) {
    const cls = classOfPath(boundaries, path, added ?? false);
    result.set(cls, [...(result.get(cls) ?? []), path]);
  }
  return new Map([...result.entries()].sort(([a], [b]) => compareClass(a, b)));
}
