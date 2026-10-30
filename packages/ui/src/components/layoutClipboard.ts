// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { importLayoutSvg, LAYOUT_DEFAULT_TEXT, type LayoutEntity, type LayoutPage, type LayoutDocumentState } from '@pushform/layout';
import { fittedLayoutTextBounds } from './layoutText';
import { readClipboardTable } from './layoutClipboardTable';
import { readClipboardRichText, readHtmlRichText, type ClipboardRichText } from './layoutClipboardRichText';
import { clipboardStyleReader } from './clipboardHtml';

export const LAYOUT_CLIPBOARD_TYPE = 'application/x-pushform-layout';
export type LayoutClipboardContent = { kind: 'object'; entities: unknown[] } | { kind: 'text'; text: string; rich?: ClipboardRichText } |
  { kind: 'image' | 'svg'; source: Blob | string } | { kind: 'html'; html: string; images: File[] };
const imageType = /^image\/(png|jpeg|jpg|svg\+xml|webp|gif|bmp|avif)$/i;
const imageUrl = /^data:image\/(png|jpeg|jpg|svg\+xml|webp|gif|bmp|avif)[;,]/i;
const svgSource = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
const svgImageSource = (source: Blob | string): boolean => typeof source === 'string'
  ? /^data:image\/svg\+xml[;,]/i.test(source.trim()) || svgSource.test(source)
  : source.type === 'image/svg+xml' || source instanceof File && /\.svg$/i.test(source.name);

/** Snapshot the event synchronously: browser clipboard data is only available during the paste event. */
export function readLayoutClipboard(data: DataTransfer, plain = false): LayoutClipboardContent | null {
  if (plain) {
    const rich = readClipboardRichText(data, true);
    return rich ? { kind: 'text', text: rich.content } : null;
  }
  const html = data.getData('text/html');
  const carrier = html ? new DOMParser().parseFromString(html, 'text/html').querySelector('[data-pushform-layout]')?.getAttribute('data-pushform-layout') : null;
  const own = data.getData(LAYOUT_CLIPBOARD_TYPE) || (carrier ? decodeURIComponent(carrier) : '');
  if (own) {
    const payload = JSON.parse(own) as { version?: number; entities?: unknown[] };
    if (payload?.version !== 1 || !Array.isArray(payload.entities) || !payload.entities.length) throw new Error('Unsupported Layout clipboard content.');
    return { kind: 'object', entities: payload.entities };
  }
  const text = data.getData('text/plain');
  const files = [...Array.from(data.items ?? []).flatMap(item => item.kind === 'file' ? [item.getAsFile()] : []), ...Array.from(data.files ?? [])];
  const images = [...new Set(files.filter((file): file is File => Boolean(file && (imageType.test(file.type) || /\.(svg|png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name)))))];
  const svg = data.getData('image/svg+xml') || data.getData('image/x-inkscape-svg');
  if (svg) return { kind: 'svg', source: svg };
  const svgFile = images.find(file => file.type === 'image/svg+xml' || /\.svg$/i.test(file.name));
  if (svgFile) return { kind: 'svg', source: svgFile };
  if (svgImageSource(text)) return { kind: 'svg', source: text.trim() };
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rest = doc.body.cloneNode(true) as Element;
    rest.querySelectorAll('table, img, svg, style, script').forEach(node => node.remove());
    if ((doc.querySelector('img, svg, table') && rest.textContent?.trim()) || doc.querySelectorAll('table').length > 1 ||
      doc.querySelectorAll('img, svg').length > 1 && !doc.querySelector('table') || doc.querySelectorAll('p,h1,h2,h3,h4,h5,h6,pre,blockquote,ul,ol').length > 1)
      return { kind: 'html', html, images };
    if (!doc.querySelector('img, svg, table')) {
      const rich = readClipboardRichText(data);
      if (rich) return { kind: 'text', text: rich.content, rich };
    }
    // Chrome may expose vector clipboard content as an HTML image plus a PNG preview.
    const embedded = doc.querySelector('svg');
    if (embedded) return { kind: 'svg', source: new XMLSerializer().serializeToString(embedded) };
    const src = doc.querySelector('img')?.getAttribute('src');
    if (src && svgImageSource(src)) return { kind: 'svg', source: src };
  }
  if (!html && (data.getData('text/rtf') || data.getData('application/rtf') || data.getData('text/richtext'))) {
    const rich = readClipboardRichText(data);
    if (rich) return { kind: 'text', text: rich.content, rich };
  }
  const imageSource = imageUrl.test(text.trim()) || svgSource.test(text);
  const table = readClipboardTable(html, imageSource ? '' : text);
  if (table) return { kind: 'object', entities: [table] };
  const file = images[0];
  if (file) return { kind: file.type === 'image/svg+xml' || /\.svg$/i.test(file.name) ? 'svg' : 'image', source: file };
  if (imageSource)
    return { kind: svgSource.test(text) || /^data:image\/svg\+xml/i.test(text) ? 'svg' : 'image', source: text.trim() };
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const src = doc.querySelector('img')?.getAttribute('src');
    if (src && imageUrl.test(src)) return { kind: 'image', source: src };
    const svg = doc.querySelector('svg');
    if (svg) return { kind: 'svg', source: new XMLSerializer().serializeToString(svg) };
  }
  const rich = readClipboardRichText(data);
  return rich ? { kind: 'text', text: rich.content, ...(html || data.getData('text/rtf') || data.getData('application/rtf') || data.getData('text/richtext') ? { rich } : {}) } : null;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the pasted image.'));
    reader.readAsDataURL(blob);
  });
}

function svgRoot(source: string): SVGElement {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || doc.querySelector('parsererror')) throw new Error('The pasted SVG is invalid.');
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  root.querySelectorAll('script, foreignObject, link, iframe, object, animate, animateTransform, set').forEach(node => node.remove());
  const styleOf = clipboardStyleReader(doc);
  const properties = ['fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
    'stroke-linecap', 'stroke-linejoin', 'clip-path', 'mask', 'filter', 'opacity', 'display', 'visibility', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor'];
  for (const node of [root, ...root.querySelectorAll('*')]) {
    const css = styleOf(node), clean = (doc.createElementNS('http://www.w3.org/1999/xhtml', 'span') as HTMLElement).style;
    for (const property of properties) {
      const value = css.getPropertyValue(property);
      if (value) clean.setProperty(property, value);
    }
    if (clean.cssText) node.setAttribute('style', clean.cssText); else node.removeAttribute('style');
    for (const attr of Array.from(node.attributes)) {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      if (/href$/i.test(attr.name) && !attr.value.startsWith('#') && !imageUrl.test(attr.value))
        throw new Error('External SVG resources cannot be pasted.');
      for (const match of attr.value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g))
        if (!match[2]!.startsWith('#') && !imageUrl.test(match[2]!)) throw new Error('External SVG resources cannot be pasted.');
    }
  }
  // Paper measures styles in a temporary DOM sandbox: only inert, resolved styles may reach it.
  root.querySelectorAll('style').forEach(node => node.remove());
  // Give viewBox-only SVGs intrinsic dimensions with the correct aspect ratio.
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!root.hasAttribute('width') && !root.hasAttribute('height') && box?.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0) {
    root.setAttribute('width', String(box[2])); root.setAttribute('height', String(box[3]));
  }
  return root as unknown as SVGElement;
}

function svgBlob(source: string): Blob { return new Blob([new XMLSerializer().serializeToString(svgRoot(source))], { type: 'image/svg+xml' }); }

function readBlobText(source: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the pasted content.')); reader.readAsText(source);
  });
}

export async function layoutClipboardSvg(source: Blob | string, page: LayoutPage): Promise<LayoutEntity[]> {
  let text = typeof source === 'string' ? source : await readBlobText(source);
  if (/^data:image\/svg\+xml/i.test(text)) {
    const comma = text.indexOf(','), header = text.slice(0, comma), body = text.slice(comma + 1);
    text = /;base64/i.test(header) ? new TextDecoder().decode(Uint8Array.from(atob(body), char => char.charCodeAt(0))) : decodeURIComponent(body);
  }
  const root = svgRoot(text);
  const native = importLayoutSvg(root, [Math.max(1, page.size[0] - 20), Math.max(1, page.size[1] - 20)]);
  if (!native?.length) throw new Error('This SVG has no supported editable shapes or text. Use Import to place it as an image.');
  return native;
}

export async function layoutClipboardImage(source: Blob | string, page: LayoutPage): Promise<LayoutEntity> {
  let src: string;
  if (typeof source === 'string') src = imageUrl.test(source) ? source : await dataUrl(svgBlob(source));
  else if (source.type === 'image/svg+xml' || source instanceof File && /\.svg$/i.test(source.name)) {
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read the pasted SVG.')); reader.readAsText(source);
    });
    src = await dataUrl(svgBlob(text));
  } else {
    const extension = source instanceof File ? source.name.split('.').at(-1)?.toLowerCase() : undefined;
    const type = source.type || `image/${extension === 'jpg' ? 'jpeg' : extension ?? 'png'}`;
    src = await dataUrl(source.type ? source : new Blob([source], { type }));
  }
  const [width, height] = await new Promise<[number, number]>((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => { image.onload = image.onerror = null; reject(new Error('The pasted image could not be loaded.')); }, 15000);
    image.onload = () => {
      clearTimeout(timer);
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve([image.naturalWidth, image.naturalHeight]);
      else reject(new Error('The pasted image has no size.'));
    };
    image.onerror = () => { clearTimeout(timer); reject(new Error('The pasted image could not be loaded.')); };
    image.src = src;
  });
  const scale = Math.min(25.4 / 96, Math.max(1, page.size[0] - 20) / width, Math.max(1, page.size[1] - 20) / height);
  const w = width * scale, h = height * scale;
  return { id: 0, layerId: 0, kind: 'image', closed: true, points: [[0, 0], [w, 0], [w, h], [0, h]], image: { src } };
}

export function layoutClipboardText(content: string, page: LayoutPage, state: LayoutDocumentState, rich?: ClipboardRichText): LayoutEntity {
  const entity: LayoutEntity = { id: 0, layerId: 0, kind: 'text', closed: false, points: [[0, 0], [60, 20]],
    text: { content, ...LAYOUT_DEFAULT_TEXT, bold: false, italic: false,
      underline: false, align: 'left', vertical: 'top', bounded: false, leader: 'none', endpoint: 'none', ...rich } };
  const ctx = document.createElement('canvas').getContext('2d');
  entity.points = ctx ? fittedLayoutTextBounds(ctx, entity, page, state) : [[0, 0],
    [Math.max(1, ...content.split('\n').map(line => line.length * 12 * 25.4 / 72 * 0.6)), content.split('\n').length * 12 * 25.4 / 72 * 1.25]];
  return entity;
}

/** Mixed selections become native blocks in reading order, inserted together in one transaction. */
export async function layoutClipboardHtml(html: string, page: LayoutPage, state: LayoutDocumentState, images: readonly File[] = []): Promise<LayoutEntity[]> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const result: LayoutEntity[] = [];
  let top = 0;
  let imageIndex = 0;
  const append = (entities: LayoutEntity[]) => {
    const points = entities.flatMap(entity => entity.points), minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
    const delta = top - minY;
    result.push(...entities.map(entity => ({ ...entity, points: entity.points.map(([x, y]) => [x, y + delta] as [number, number]),
      ...(entity.handles ? { handles: entity.handles.map(handle => ({ ...(handle.in ? { in: [handle.in[0], handle.in[1] + delta] as [number, number] } : {}), ...(handle.out ? { out: [handle.out[0], handle.out[1] + delta] as [number, number] } : {}) })) } : {}) })));
    top += maxY - minY + 3;
  };
  const visit = async (node: Node): Promise<void> => {
    if (node instanceof Element) {
      if (['style', 'script', 'meta', 'link'].includes(node.localName)) return;
      if (node.localName === 'table') {
        const table = readClipboardTable(`${doc.head.innerHTML}${node.outerHTML}`, '');
        if (table) append([table]); return;
      }
      if (node.localName === 'img') {
        const src = node.getAttribute('src') ?? '';
        const source = imageUrl.test(src) ? src : images.find(file => src.endsWith(`/${file.name}`)) ?? images[imageIndex++];
        if (!source) throw new Error('The pasted image must be embedded in the clipboard.');
        append(svgImageSource(source) ? await layoutClipboardSvg(source, page) : [await layoutClipboardImage(source, page)]); return;
      }
      if (node.localName === 'svg') { append(await layoutClipboardSvg(new XMLSerializer().serializeToString(node), page)); return; }
      if (node.querySelector('img, svg, table, p, h1, h2, h3, h4, h5, h6, pre, blockquote, ul, ol')) { for (const child of Array.from(node.childNodes)) await visit(child); return; }
    }
    const rich = readHtmlRichText(node);
    if (rich.content.trim()) append([layoutClipboardText(rich.content, page, state, rich)]);
  };
  for (const child of Array.from(doc.body.childNodes)) await visit(child);
  if (!result.length) throw new Error('There is no supported content to paste.');
  return result;
}
