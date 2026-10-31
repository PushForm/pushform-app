// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useState, useSyncExternalStore, type JSX } from 'react';
import { writeLayoutSvg } from '@pushform/io/vector';
import type { PrintRequest, ViewPrinter } from '@pushform/extensions';
import { Dialog } from '../components/DialogParts';
import { browserFilePicker } from './browserExtensionIo';

/**
 * Printing for extensions. An extension asks to print some of its vector views; PushForm shows its own dialog naming
 * the extension, its stated purpose, the page count and size, with a preview of the first page, and the user chooses
 * Print, Save as PDF or Cancel. Pages are drawn from PushForm's own SVG of each view, shown as images, so nothing the
 * extension sent becomes markup in the print document. The extension learns only whether the pages were printed or
 * saved.
 */

export type PrintChoice = 'print' | 'pdf';

interface Pending {
  readonly request: PrintRequest;
  readonly resolve: (choice: PrintChoice | null) => void;
}

/** The print requests waiting for the user, one shown at a time. */
export class PrintPrompts {
  private queue: readonly Pending[] = [];
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly current = (): Pending | null => this.queue[0] ?? null;

  ask(request: PrintRequest): Promise<PrintChoice | null> {
    return new Promise((resolve) => this.set([...this.queue, { request, resolve }]));
  }

  answer(choice: PrintChoice | null): void {
    const [first, ...rest] = this.queue;
    if (!first) return;
    this.set(rest);
    first.resolve(choice);
  }

  private set(queue: readonly Pending[]): void {
    this.queue = queue;
    for (const listener of this.listeners) listener();
  }
}

export interface PrintOutput {
  /** Opens the browser's print dialog for the pages. */
  print(request: PrintRequest): Promise<void>;
  /** Writes the pages as a PDF where the user chooses; false when they cancelled. */
  savePdf(request: PrintRequest): Promise<boolean>;
}

/** The `ui.print` host: the user's choice in the dialog, then printing or a PDF. */
export function browserViewPrinter(prompts: PrintPrompts, output: PrintOutput = browserPrintOutput()): ViewPrinter {
  return {
    async print(request) {
      const choice = await prompts.ask(request);
      if (choice === 'print') { await output.print(request); return 'printed'; }
      if (choice === 'pdf') return (await output.savePdf(request)) ? 'saved' : null;
      return null;
    },
  };
}

const svgUrl = (svg: string): string => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
const safeName = (name: string): string => name.replace(/[/\\:*?"<>|\p{Cc}]/gu, '-').trim().slice(0, 120) || 'Print';

export function browserPrintOutput(doc: Document = document): PrintOutput {
  return {
    async print(request) {
      const frame = doc.createElement('iframe');
      frame.title = 'Extension print document';
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;';
      doc.body.append(frame);
      const urls: string[] = [];
      const cleanup = (): void => { frame.remove(); for (const url of urls) URL.revokeObjectURL(url); };
      try {
        const target = frame.contentWindow, page = frame.contentDocument;
        if (!target || !page) throw new Error('The print document could not be opened.');
        page.open(); page.write('<!doctype html><html><head></head><body></body></html>'); page.close();
        page.title = request.title;
        const { width, height } = request.page;
        const style = page.createElement('style');
        style.textContent = `@page { size: ${width}mm ${height}mm; margin: 0; }
          html, body { margin: 0; padding: 0; background: #fff; }
          img { display: block; width: ${width}mm; height: ${height}mm; break-inside: avoid; }
          img + img { break-before: page; }`;
        page.head.append(style);
        const images = request.pages.map((vectorPage) => {
          const image = page.createElement('img');
          const url = svgUrl(writeLayoutSvg(vectorPage, 'page'));
          urls.push(url);
          image.alt = vectorPage.name;
          image.src = url;
          page.body.append(image);
          return image;
        });
        await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
        target.addEventListener('afterprint', cleanup, { once: true });
        target.focus();
        target.print();
        // Some browsers return before the preview closes; the document stays until afterprint, or a minute at most.
        setTimeout(cleanup, 60_000);
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    async savePdf(request) {
      const [{ writeLayoutPdf }, { loadPdfWebFont }] = await Promise.all([import('../components/layoutPdf'), import('../components/layoutPdfExport')]);
      const { bytes } = await writeLayoutPdf(request.pages, loadPdfWebFont);
      // The dialog's button was the user's choice; the browser's own save prompt follows.
      const saved = await browserFilePicker(async () => true, doc).save({
        extensionName: request.extensionName, kind: 'save', purpose: request.purpose,
        accept: [{ description: 'PDF document', extensions: ['pdf'] }], suggestedName: `${safeName(request.title)}.pdf`,
      }, bytes);
      return saved !== null;
    },
  };
}

const formatSize = ({ width, height }: { width: number; height: number }): string => {
  const mm = (v: number): string => String(Math.round(v * 10) / 10);
  const inches = (v: number): string => String(Math.round((v / 25.4) * 100) / 100);
  return `${mm(width)} × ${mm(height)} mm (${inches(width)} × ${inches(height)} in)`;
};

/** PushForm's print dialog for extension requests; the extension cannot style or fill it. */
export function ExtensionPrintDialog({ prompts }: { readonly prompts: PrintPrompts }): JSX.Element | null {
  const pending = useSyncExternalStore(prompts.subscribe, prompts.current);
  const request = pending?.request ?? null;
  const preview = useMemo(() => (request ? svgUrl(writeLayoutSvg(request.pages[0]!, 'page')) : null), [request]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [request]);
  if (!request) return null;
  const count = request.pages.length;
  const choose = (choice: PrintChoice | null): void => { setBusy(choice !== null); prompts.answer(choice); };
  return (
    <Dialog title={`Print from ${request.extensionName}?`} onClose={() => choose(null)}>
      <div className="pf-xprint">
        <p className="pf-xprint-purpose">{request.purpose}</p>
        <dl className="pf-xinstall-facts">
          <dt>Document</dt><dd>{request.title}</dd>
          <dt>Pages</dt><dd>{count === 1 ? '1 page' : `${count} pages`}</dd>
          <dt>Page size</dt><dd>{formatSize(request.page)}</dd>
        </dl>
        {preview ? <img className="pf-xprint-preview" src={preview} alt={`Preview of page 1 of ${count}`}
          style={{ aspectRatio: `${request.page.width} / ${request.page.height}` }} /> : null}
        <p className="pf-xprint-note">Choose the paper size in your printer settings to match, and print at 100 % scale so labels line up.</p>
        <div className="pf-form-actions">
          <button type="button" className="pf-btn pf-xui-button is-primary" disabled={busy} onClick={() => choose('print')}>Print…</button>
          <button type="button" className="pf-btn" disabled={busy} onClick={() => choose('pdf')}>Save as PDF…</button>
          <button type="button" className="pf-btn" onClick={() => choose(null)}>Cancel</button>
        </div>
      </div>
    </Dialog>
  );
}
