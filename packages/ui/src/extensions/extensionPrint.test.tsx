// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PrintRequest } from '@pushform/extensions';
import { ExtensionPrintDialog, PrintPrompts, browserViewPrinter } from './extensionPrint';

afterEach(cleanup);

const request: PrintRequest = {
  extensionName: 'Cut list', purpose: 'Print part labels', title: 'Labels for Bookcase',
  page: { width: 215.9, height: 279.4 },
  pages: [1, 2].map((n) => ({ paperUnits: 'mm' as const, name: `Labels ${n}`, width: 215.9, height: 279.4, background: '#ffffff', items: [] })),
};

function setup() {
  const done: string[] = [];
  const prompts = new PrintPrompts();
  const printer = browserViewPrinter(prompts, {
    print: async () => { done.push('print'); },
    savePdf: async () => { done.push('pdf'); return true; },
  });
  render(<ExtensionPrintDialog prompts={prompts} />);
  return { done, printer };
}

describe('the extension print dialog', () => {
  it('names the extension, purpose, pages and size, and prints on Print', async () => {
    const { done, printer } = setup();
    let outcome: unknown;
    act(() => { void printer.print(request).then((o) => { outcome = o; }); });
    const dialog = await screen.findByRole('dialog', { name: 'Print from Cut list?' });
    expect(dialog.textContent).toContain('Print part labels');
    expect(dialog.textContent).toContain('2 pages');
    expect(dialog.textContent).toContain('215.9 × 279.4 mm (8.5 × 11 in)');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Print…' })); });
    expect(done).toEqual(['print']);
    expect(outcome).toBe('printed');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('saves a PDF, or does nothing when cancelled', async () => {
    const { done, printer } = setup();
    const outcomes: unknown[] = [];
    act(() => { void printer.print(request).then((o) => outcomes.push(o)); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Save as PDF…' })); });
    act(() => { void printer.print(request).then((o) => outcomes.push(o)); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Cancel' })); });
    expect(done).toEqual(['pdf']);
    expect(outcomes).toEqual(['saved', null]);
  });
});
