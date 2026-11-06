// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { commonsExactSearch, commonsSearchMatcher } from './CommonsSearch';

const matching = (query: string, texts: string[]) => texts.filter(commonsSearchMatcher(query));
const authors = ['Steven Osborn', 'Steve Jones', 'John Osborn', 'Steven  Osborne', 'Osborn, Steven', 'Steven Osborn-Smith'];

describe('Commons search', () => {
  it('requires every bare word somewhere, as part of any word', () => {
    expect(matching('steven osborn', authors)).toEqual(['Steven Osborn', 'Steven  Osborne', 'Osborn, Steven', 'Steven Osborn-Smith']);
    expect(matching('', authors)).toEqual(authors);
  });
  it('matches a quoted phrase only as whole words in that order', () => {
    expect(matching('"Steven Osborn"', authors)).toEqual(['Steven Osborn', 'Steven Osborn-Smith']);
    expect(matching('"steven   osborn"', ['STEVEN\tOSBORN'])).toEqual(['STEVEN\tOSBORN']);
    expect(matching('"Ann Lee"', ['Joann Leeds', 'Ann Lee', 'by Ann Lee.'])).toEqual(['Ann Lee', 'by Ann Lee.']);
  });
  it('combines phrases and bare words, and reads curly and unclosed quotes', () => {
    expect(matching('hinge "Steven Osborn"', ['Hinge · Steven Osborn', 'Bench · Steven Osborn'])).toEqual(['Hinge · Steven Osborn']);
    expect(matching('“Steven Osborn”', authors)).toEqual(['Steven Osborn', 'Steven Osborn-Smith']);
    expect(matching('"Steven Osb', authors)).toEqual([]);
    expect(matching('""', authors)).toEqual(authors);
  });
  it('keeps an inch mark as part of its word and treats regex characters literally', () => {
    expect(matching('24" cabinet', ['24" base cabinets', '24 in cabinet'])).toEqual(['24" base cabinets']);
    expect(matching('"C++ (v2)"', ['Joint C++ (v2) sample', 'C (v2)'])).toEqual(['Joint C++ (v2) sample']);
  });
  it('does not let a phrase run across separate fields', () => {
    expect(matching('"hinge example"', [['Workshop hinge', 'Example Maker'].join(' · ')])).toEqual([]);
  });
  it('quotes a name for an exact search unless the name contains a quote', () => {
    expect(commonsExactSearch('  Robert   Goossens ')).toBe('"Robert Goossens"');
    expect(commonsExactSearch('Jo "JJ" Smith')).toBe('Jo "JJ" Smith');
    expect(commonsExactSearch('  ')).toBe('');
  });
});
