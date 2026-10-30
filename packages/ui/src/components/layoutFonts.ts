// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { tableCellEntities, layoutTextStyleAt, type LayoutEntity } from '@pushform/layout';
import { GOOGLE_LAYOUT_FONTS } from './layoutFontCatalog';

type Status = 'loading' | 'ready' | 'failed';
const catalog = new Map<string, (typeof GOOGLE_LAYOUT_FONTS)[number]>(GOOGLE_LAYOUT_FONTS.map(font => [font.family, font]));
const sheets = new Map<string, Promise<void>>(), statuses = new Map<string, Status>();
const pendingFaces = new Map<string, Promise<void>>();
const readyFaces = new Set<string>();
const listeners = new Set<() => void>();
let generation = 0;
const changed = () => { generation++; for (const notify of listeners) notify(); };

export const layoutFontLoads = {
  subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
  version: () => generation,
};
export const layoutFontStatus = (family: string): Status | undefined => statuses.get(family);
/** Whether this face and glyph subset has been confirmed available, independent of other faces of the family. */
export const layoutFontFaceReady = (descriptor: string, sample: string): boolean => readyFaces.has(`${descriptor}\n${sample}`);
export const isGoogleLayoutFont = (family: string): boolean => catalog.has(family);

export function googleLayoutFontUrl(family: string): string | null {
  const font = catalog.get(family);
  if (!font) return null;
  const italic = font.styles.some(style => style.startsWith('1,'));
  const spec = italic ? `ital,wght@${font.styles.join(';')}` : `wght@${font.styles.map(style => style.slice(2)).join(';')}`;
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${spec}&display=swap`;
}

function loadStylesheet(family: string): Promise<void> {
  const existing = sheets.get(family);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = googleLayoutFontUrl(family)!;
    link.dataset.layoutFont = family;
    const finish = (error?: Error) => {
      clearTimeout(timeout); link.onload = link.onerror = null;
      if (error) { statuses.set(family, 'failed'); link.remove(); changed(); reject(error); }
      else resolve();
    };
    link.onload = () => finish();
    link.onerror = () => finish(new Error(`Could not load ${family}. Check your connection and try again.`));
    const timeout = setTimeout(() => finish(new Error(`${family} is still loading. Try again when your connection is available.`)), 15000);
    statuses.set(family, 'loading'); document.head.append(link);
  });
  sheets.set(family, promise);
  return promise;
}

/** Include range-specific styles and annotation fonts, including shared entities supplied by the caller. */
export function layoutFontRequests(entities: readonly LayoutEntity[]) {
  const requests = new Map<string, { family: string; descriptor: string; sample: string }>();
  const add = (family: string, bold: boolean, italic: boolean, sample: string) => {
    if (!catalog.has(family)) return;
    const descriptor = `${italic ? 'italic' : 'normal'} ${bold ? 700 : 400} 16px "${family}"`;
    const previous = requests.get(descriptor);
    requests.set(descriptor, { family, descriptor, sample: (previous?.sample ?? '') + sample });
  };
  for (const entity of entities.flatMap(entity => entity.table ? tableCellEntities(entity) : [entity])) {
    if (entity.text) {
      const text = entity.text;
      // Include the default face for empty text and new typing, plus each effective range face.
      add(text.fontFamily, text.bold, text.italic, text.content || 'Aa');
      const boundaries = [...new Set([0, text.content.length, ...(text.spans ?? []).flatMap(span => [span.start, span.end])])].sort((a, b) => a - b);
      for (let i = 0; i < boundaries.length - 1; i++) {
        const start = boundaries[i]!, end = boundaries[i + 1]!;
        const style = layoutTextStyleAt(text, start);
        add(style.fontFamily, style.bold, style.italic, text.content.slice(start, end));
      }
    }
    const dim = entity.dimension ?? entity.angularDimension;
    if (dim) add(dim.fontFamily, false, false, `${dim.text}0123456789.° mm cm in ft`);
  }
  return [...requests.values()];
}

/** Await CSS registration and the actual faces/glyph subsets, rather than merely document.fonts.ready. */
export async function prepareLayoutFonts(entities: readonly LayoutEntity[]): Promise<void> {
  const requests = layoutFontRequests(entities);
  if (!requests.length || !document.fonts?.load) return;
  await Promise.all(requests.map(async ({ family, descriptor, sample }) => {
    if (statuses.get(family) === 'failed') throw new Error(`Could not load ${family}. Check your connection and reload to retry.`);
    await loadStylesheet(family);
    const key = `${descriptor}\n${sample}`;
    if (document.fonts.check(descriptor, sample)) {
      const fresh = !readyFaces.has(key); readyFaces.add(key);
      if (statuses.get(family) !== 'ready') { statuses.set(family, 'ready'); changed(); } else if (fresh) changed();
      return;
    }
    let pending = pendingFaces.get(key);
    if (!pending) {
      pending = (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const faces = await Promise.race([
            document.fonts.load(descriptor, sample),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`${family} is still loading.`)), 15000); }),
          ]);
          if (!faces.length) throw new Error(`Could not load ${family}.`);
          readyFaces.add(key); statuses.set(family, 'ready'); changed();
        } catch (cause) { statuses.set(family, 'failed'); changed(); throw cause; }
        finally { clearTimeout(timeout); pendingFaces.delete(key); }
      })();
      pendingFaces.set(key, pending);
    }
    await pending;
  }));
}
