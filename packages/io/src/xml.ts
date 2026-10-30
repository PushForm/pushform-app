// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Minimal, namespace-aware XML reader for trusted-structure imports (no DTDs, no external entities). */
export interface XmlElement {
  /** Local name; element prefixes are dropped because importers match on local names. */
  name: string;
  /** Attribute keys are `prefix:local` with the prefix normalized through `attributePrefixes`, else the local name. */
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
  /** Opt-in original source for lossless preservation; absent for normal parsed documents. */
  source?: { xml: string; namespaces: Record<string, string>; ancestors: string[] };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

/**
 * Parse an XML document into an element tree. `attributePrefixes` maps namespace URIs to the
 * prefix used in `attrs` keys, so documents that bind the same namespace to different prefixes
 * read identically.
 */
export function parseXml(source: string, attributePrefixes: Record<string, string> = {}, capture?: (name: string) => boolean): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: { element: XmlElement; scope: Map<string, string>; start: number }[] = [{ element: root, scope: new Map(), start: 0 }];
  const tag = /<(\/?)([^\s/>!?]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[^]*?-->|<\?[^]*?\?>|<!\[CDATA\[([^]*?)\]\]>|<![^>]*>/g;
  const attribute = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let last = 0;
  for (const match of source.matchAll(tag)) {
    const top = stack.at(-1)!;
    if (match.index > last) top.element.text += decodeEntities(source.slice(last, match.index));
    last = match.index + match[0].length;
    const [, closing, qname, rawAttrs, selfClosing, cdata] = match;
    if (cdata !== undefined) { top.element.text += cdata; continue; }
    if (!qname) continue;
    if (closing) {
      if (stack.length === 1 || localName(top.element.name) !== localName(qname)) throw new Error(`Malformed XML near </${qname}>`);
      if (top.element.source) top.element.source.xml = source.slice(top.start, last);
      stack.pop();
      continue;
    }
    // Elements share their parent's namespace scope unless they declare a namespace of their own.
    let scope = top.scope;
    const raw: [string, string][] = [];
    for (const [, key, double, single] of rawAttrs ? rawAttrs.matchAll(attribute) : []) {
      const value = decodeEntities(double ?? single ?? '');
      const declared = key === 'xmlns' ? '' : key!.startsWith('xmlns:') ? key!.slice(6) : null;
      if (declared === null) { raw.push([key!, value]); continue; }
      if (scope === top.scope) scope = new Map(scope);
      scope.set(declared, value);
    }
    const attrs: Record<string, string> = {};
    for (const [key, value] of raw) {
      const colon = key.indexOf(':');
      if (colon < 0) { attrs[key] = value; continue; }
      const prefix = attributePrefixes[scope.get(key.slice(0, colon)) ?? ''];
      const normalized = prefix ? `${prefix}:${key.slice(colon + 1)}` : key.slice(colon + 1);
      // Unknown extension attributes must not overwrite a structural unqualified id/ref.
      attrs[!prefix && normalized in attrs ? key : normalized] = value;
    }
    const element: XmlElement = { name: localName(qname), attrs, children: [], text: '' };
    if (capture?.(element.name)) element.source = {
      xml: selfClosing ? match[0] : '', namespaces: Object.fromEntries(scope), ancestors: stack.slice(1).map(parent => parent.element.name),
    };
    top.element.children.push(element);
    if (!selfClosing) stack.push({ element, scope, start: match.index });
  }
  if (stack.length !== 1) throw new Error('Malformed XML: unclosed elements');
  const documentElement = root.children[0];
  if (!documentElement) throw new Error('XML document has no root element');
  return documentElement;
}

function localName(qname: string): string {
  const colon = qname.indexOf(':');
  return colon < 0 ? qname : qname.slice(colon + 1);
}

export function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((item) => item.name === name);
}

export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((item) => item.name === name);
}
