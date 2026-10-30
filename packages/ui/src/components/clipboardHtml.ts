// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
const readers = new WeakMap<Document, (element: Element) => CSSStyleDeclaration>();

/** Parse clipboard CSS in an unattached stylesheet, never in the application's DOM. */
export function clipboardStyleReader(doc: Document) {
  const cached = readers.get(doc);
  if (cached) return cached;
  const rules: { selector: string; style: CSSStyleDeclaration; specificity: number }[] = [];
  for (const element of doc.querySelectorAll('style')) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(element.textContent ?? '');
    for (const rule of Array.from(sheet.cssRules)) {
      if (!('selectorText' in rule) || !('style' in rule)) continue;
      const css = rule as CSSStyleRule;
      for (const selector of css.selectorText.split(',')) {
        if (!/^[\w\s.*#>+~-]+$/.test(selector)) continue;
        const specificity = (selector.match(/#/g)?.length ?? 0) * 10000 +
          (selector.match(/\./g)?.length ?? 0) * 100 + (selector.match(/(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0);
        rules.push({ selector, style: css.style, specificity });
      }
    }
  }
  const read = (element: Element): CSSStyleDeclaration => {
    const result = (doc.createElementNS('http://www.w3.org/1999/xhtml', 'span') as HTMLElement).style;
    const matches = rules.filter(rule => {
      try { return element.matches(rule.selector); } catch { return false; }
    });
    const inline = (element as HTMLElement).style;
    if (inline) matches.push({ selector: '', style: inline, specificity: 1000000 });
    matches.sort((a, b) => a.specificity - b.specificity);
    for (const match of matches) for (const key of Array.from(match.style)) {
      const priority = match.style.getPropertyPriority(key);
      if (result.getPropertyPriority(key) !== 'important' || priority === 'important')
        result.setProperty(key, match.style.getPropertyValue(key), priority);
    }
    return result;
  };
  readers.set(doc, read);
  return read;
}

export function clipboardColor(color: string, doc: Document): string | undefined {
  if (!color || /\b(?:var|env|currentcolor|inherit|initial|unset|revert)\b/i.test(color)) return undefined;
  const style = (doc.createElementNS('http://www.w3.org/1999/xhtml', 'span') as HTMLElement).style;
  style.color = color;
  const valid = style.color;
  if (!valid) return undefined;
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(valid);
  if (!rgb) return valid;
  const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  if (rgb[4] !== undefined && Number(rgb[4]) < 1) channels.push(Math.round(Number(rgb[4]) * 255));
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}
