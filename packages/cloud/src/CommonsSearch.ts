// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * Commons search rules. Every bare word must appear somewhere in the text, as part of any word. Text in double quotes
 * must appear as a whole phrase that starts and ends on word boundaries, so `"Ann Lee"` matches "Ann Lee" but not
 * "Joann Leeds". A quote opens a phrase only at the start of the query or after a space, so an inch mark such as `24"`
 * stays part of its word; a phrase with no closing quote runs to the end. Curly quotes count as straight quotes. Matching
 * ignores case and treats any run of whitespace as one space. The `commons_browse` database function applies the same rules.
 */
export function commonsSearchMatcher(query: string): (text: string) => boolean {
  const phrases: RegExp[] = [];
  const rest = query.replace(/[“”„]/g, '"').toLowerCase().replace(/(^|\s)"([^"]*)"?/g, (_match, _lead: string, phrase: string) => {
    const words = phrase.trim().replace(/\s+/g, ' ');
    if (words) phrases.push(new RegExp(`(^|[^\\p{L}\\p{N}])${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u'));
    return ' ';
  });
  const words = rest.split(/\s+/).filter(Boolean);
  return (text) => {
    const haystack = text.toLowerCase().replace(/\s+/g, ' ');
    return words.every((word) => haystack.includes(word)) && phrases.every((phrase) => phrase.test(haystack));
  };
}

/** A search for exactly this name, quoted so it matches only the whole name. Names that contain a double quote are left unquoted. */
export function commonsExactSearch(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ').slice(0, 198);
  return trimmed && !/["“”„]/.test(trimmed) ? `"${trimmed}"` : trimmed;
}
