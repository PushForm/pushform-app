// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_UNITS } from '@pushform/core';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { ModelInfoPanel, purgeSummary } from './ModelInfoPanel';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

function mount(): AppInstance {
  const a = (app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) }));
  render(<AppContext.Provider value={a}><ModelInfoPanel /></AppContext.Provider>);
  return a;
}
const units = (a: AppInstance) => a.document.doc.state.meta.units;
const choose = (label: string, value: string) => fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } });

describe('Model Info Units', () => {
  it('edits the model units, each change one undo step, and locks the unit of fixed-unit formats', () => {
    const a = mount();
    expect((screen.getByRole('combobox', { name: 'Length' }) as HTMLSelectElement).disabled).toBe(true);
    choose('Format', 'decimal');
    expect((screen.getByRole('combobox', { name: 'Length' }) as HTMLSelectElement).disabled).toBe(false);
    choose('Length', 'mm');
    choose('Precision', '1');
    expect(within(screen.getByRole('combobox', { name: 'Precision' })).getByRole('option', { name: '0.0' })).toBeTruthy();
    choose('Area', 'm²');
    choose('Volume', 'l');
    choose('Angle precision', '2');
    expect(units(a)).toMatchObject({ format: 'decimal', lengthUnit: 'mm', lengthPrecision: 1, areaUnit: 'm²', volumeUnit: 'l', anglePrecision: 2 });
    act(() => void a.document.undo());
    expect(units(a).anglePrecision).toBe(DEFAULT_UNITS.anglePrecision);
    choose('Format', 'engineering');
    expect(units(a).lengthUnit).toBe('ft');
  });

  it('turns length snapping on and reads the typed snap length in the model units', () => {
    const a = mount();
    choose('Format', 'decimal');
    choose('Length', 'mm');
    const field = screen.getByRole('textbox', { name: 'Snap length' }) as HTMLInputElement;
    expect(field.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable length snapping' }));
    expect(units(a).lengthSnap).toBeCloseTo(0.0254 / 16, 12);
    fireEvent.change(field, { target: { value: '5' } });
    fireEvent.blur(field);
    expect(units(a).lengthSnap).toBeCloseTo(0.005, 12);
    fireEvent.change(field, { target: { value: 'wide' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(units(a).lengthSnap).toBeCloseTo(0.005, 12);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable length snapping' }));
    expect(units(a).lengthSnap).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable angle snapping' }));
    expect(units(a).angleSnap).toBeNull();
    expect((screen.getByRole('combobox', { name: 'Snap angle' }) as HTMLSelectElement).disabled).toBe(true);
  });
});

describe('Model Info Statistics', () => {
  it('counts the top level or nested contents and purges unused items', () => {
    const a = mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Statistics' }));
    const table = screen.getByRole('table', { name: 'Statistics' });
    const count = (label: string) => within(table).getByRole('rowheader', { name: label }).nextElementSibling?.textContent;
    expect(count('Solids')).toBe('0');
    let body = 0;
    act(() => { body = a.commands.execute('model.addBox') as number; });
    expect(count('Solids')).toBe('1');
    expect(count('Solid faces')).toBe('6');
    expect(count('Edges')).toBe('12');
    act(() => void a.commands.execute('group.make', { refs: [{ kind: 'body', path: [], id: body }] }));
    expect(count('Solids')).toBe('0');
    expect(count('Groups')).toBe('1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show nested components' }));
    expect(count('Solids')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Purge Unused' }));
    expect(screen.getByRole('status').textContent).toBe('Nothing to purge.');
    act(() => void a.commands.execute('material.create', { name: 'Spare' }));
    expect(count('Materials')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Purge Unused' }));
    expect(screen.getByRole('status').textContent).toBe('Purged 1 material.');
    expect(count('Materials')).toBe('0');
  });

  it('summarizes what was purged', () => {
    expect(purgeSummary({ definitions: 2, styles: 1, tags: 0, materials: 3, images: 1 })).toBe('Purged 2 group and component definitions, 1 style, 3 materials, 1 image.');
  });
});

describe('Model Info Dimensions', () => {
  it('sets the style new dimensions get, and updates the selected dimensions to it', () => {
    const a = mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Dimensions' }));
    const update = screen.getByRole('button', { name: 'Update Selected Dimensions' }) as HTMLButtonElement;
    expect(update.disabled).toBe(true);
    const old = a.commands.execute('dimension.add', { kind: 'linear', start: [0, 0, 0], end: [1, 0, 0], offset: [0, 1, 0], normal: [0, 0, 1] }) as number;
    choose('Dimension endpoints', 'dot');
    choose('Dimension text alignment', 'above');
    choose('Dimension text size', '14');
    expect(a.document.doc.state.meta.dimensions).toEqual({ fontSizePt: 14, arrow: 'dot', align: 'above' });
    const fresh = a.commands.execute('dimension.add', { kind: 'linear', start: [0, 0, 0], end: [0, 1, 0], offset: [1, 0, 0], normal: [0, 0, 1] }) as number;
    const dim = (id: number) => a.document.doc.rootDefinition.entities.dimensions.get(id as never)!;
    expect(dim(fresh)).toMatchObject({ fontSizePt: 14, arrow: 'dot', align: 'above' });
    expect(dim(old)).toMatchObject({ fontSizePt: 10, arrow: 'closed', align: 'screen' });
    act(() => a.document.selection.set([{ kind: 'dimension', path: [], id: old as never }]));
    fireEvent.click(screen.getByRole('button', { name: 'Update Selected Dimensions' }));
    expect(dim(old)).toMatchObject({ fontSizePt: 14, arrow: 'dot', align: 'above' });
    expect(screen.getByRole('status').textContent).toBe('Updated 1 dimension.');
  });
});

it('shows original source licenses and creator conditions in Model Info Credits', () => {
  const a = mount();
  act(() => { a.document.doc.transact('Keep source notices', draft => { draft.meta.attributions = [{ modelId: 'source-part', revision: 'revision-1', assetId: 'asset-1', title: 'Original part', creator: 'Maker', source: { name: 'Source library', url: 'https://example.com/part' },
    licenses: [{ name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/', commercialUse: 'allowed', conditions: ['Keep Maker credit.'] }], credits: [{ name: 'Maker', url: null, text: 'Original source notice.' }], file: { name: 'part.stl', sizeBytes: 3, sha256: 'a'.repeat(64) } }]; }); });
  fireEvent.click(screen.getByRole('tab', { name: 'Credits' }));
  expect(screen.getByText('Keep Maker credit.')).toBeTruthy(); expect(screen.getByText(/Original source notice/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'CC BY 3.0' }).getAttribute('href')).toBe('https://creativecommons.org/licenses/by/3.0/');
});
