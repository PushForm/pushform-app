// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_UNITS } from '@pushform/core';
import { validateUiTree, type UiEvent } from '@pushform/extension-protocol';
import { ExtensionUiView } from './ExtensionUi';
import { AUTO_HEIGHT_PX, autoVectorHeight, fittedWidth } from './VectorView';

afterEach(cleanup);

const sheet = {
  type: 'vector', id: 'sheet', label: 'Sheet 1', units: 'length', bounds: { x: 0, y: 0, width: 2.44, height: 1.22 },
  styles: [{ stroke: '#333333' }, { fill: '#e8d5b0' }, { hatch: true }],
  shapes: [
    { kind: 'rect', x: 0, y: 0, width: 2.44, height: 1.22, style: 0 },
    { kind: 'rect', x: 0.01, y: 0.01, width: 0.72, height: 0.4, style: 1, item: 'side', tip: 'Side, 720 x 400' },
    { kind: 'rect', x: 0.8, y: 0.01, width: 0.5, height: 0.4, style: 1, item: 'shelf' },
    { kind: 'text', x: 0.37, y: 0.21, text: '<b>Side</b>', size: 0.04, style: 0, item: 'side' },
    { kind: 'rect', x: 2, y: 0.8, width: 0.44, height: 0.42, style: 2 },
  ],
  selected: ['shelf'],
};

function show() {
  const events: UiEvent[] = [];
  const view = render(<ExtensionUiView tree={validateUiTree(sheet)} units={DEFAULT_UNITS} onEvent={(e) => events.push(e)} />);
  const canvas = screen.getByRole('img', { name: /Sheet 1/ }) as unknown as SVGSVGElement;
  return { events, view, canvas };
}

describe('vector views', () => {
  it('draw shapes as SVG elements, with text as text and hatching as a pattern', () => {
    const { view, canvas } = show();
    expect(canvas.getAttribute('viewBox')).toBe('0 0 2.44 1.22');
    expect(canvas.querySelectorAll('g > rect').length).toBeGreaterThanOrEqual(4);
    expect(canvas.querySelector('text')!.textContent).toBe('<b>Side</b>');
    expect(view.container.querySelector('b, script, foreignObject')).toBeNull();
    expect(canvas.querySelector('pattern#pf-xui-hatch-2')).toBeTruthy();
    // The selected item is outlined.
    expect(canvas.querySelectorAll('.pf-xui-vector-highlight .is-selected')).toHaveLength(1);
  });

  it('reports hover once per item, and select on click', () => {
    const { events, canvas } = show();
    const side = canvas.querySelector('rect[data-item="side"]')!;
    fireEvent.pointerMove(side, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(side, { clientX: 12, clientY: 11 });
    expect(screen.getByRole('tooltip').textContent).toBe('Side, 720 x 400');
    fireEvent.pointerDown(side, { button: 0, clientX: 12, clientY: 11 });
    fireEvent.pointerUp(side, { clientX: 12, clientY: 11 });
    fireEvent.pointerMove(canvas.querySelector('rect:not([data-item])')!, { clientX: 400, clientY: 300 });
    expect(events).toEqual([
      { component: 'sheet', event: 'hover', item: 'side' },
      { component: 'sheet', event: 'select', value: 'side' },
      { component: 'sheet', event: 'hover', item: null },
    ]);
  });

  it('zooms, fits and steps through items from the keyboard', () => {
    const { events, canvas } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(canvas.getAttribute('viewBox')).not.toBe('0 0 2.44 1.22');
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(canvas.getAttribute('viewBox')).toBe('0 0 2.44 1.22');
    fireEvent.keyDown(canvas, { key: ']' });
    fireEvent.keyDown(canvas, { key: ']' });
    fireEvent.keyDown(canvas, { key: 'Enter' });
    expect(events).toEqual([
      { component: 'sheet', event: 'hover', item: 'side' },
      { component: 'sheet', event: 'hover', item: 'shelf' },
      { component: 'sheet', event: 'select', value: 'shelf' },
    ]);
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    expect(canvas.getAttribute('viewBox')!.startsWith('0.244')).toBe(true);
  });

  it('size the frame from the drawing at the width available when no height is given, within limits', () => {
    expect(autoVectorHeight({ width: 2.44, height: 1.22 }, 300)).toBe(150);
    expect(autoVectorHeight({ width: 10, height: 0.1 }, 300)).toBe(AUTO_HEIGHT_PX.min);
    expect(autoVectorHeight({ width: 1, height: 10 }, 300)).toBe(AUTO_HEIGHT_PX.max);
    expect(autoVectorHeight({ width: 1, height: 1 }, 0)).toBe(AUTO_HEIGHT_PX.unmeasured);
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('pf-xui-vector-frame') ? 316 : 0;
    });
    try {
      const { view } = show();
      expect((view.container.querySelector('.pf-xui-vector-frame') as HTMLElement).style.height).toBe('158px');
    } finally { width.mockRestore(); }
  });

  it('size a drawing as if it were as wide as its fit width, so several drawings share one scale', () => {
    const offcut = { ...sheet, id: 'offcut', label: 'Off-cut', bounds: { x: 0, y: 0, width: 0.61, height: 0.61 }, fitWidth: 2.44 };
    expect(fittedWidth({ bounds: offcut.bounds, fitWidth: 2.44 })).toBe(2.44);
    expect(fittedWidth({ bounds: offcut.bounds, fitWidth: 0.1 })).toBe(0.61);
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('pf-xui-vector-frame') ? 488 : 0;
    });
    try {
      const events: UiEvent[] = [];
      const view = render(<ExtensionUiView tree={validateUiTree(offcut)} units={DEFAULT_UNITS} onEvent={(e) => events.push(e)} />);
      // The frame is as tall as the off-cut at the sheet's scale (488 px for 2.44 m, so 122 px for 0.61 m), not a square.
      expect((view.container.querySelector('.pf-xui-vector-frame') as HTMLElement).style.height).toBe('122px');
      const canvas = screen.getByRole('img', { name: /Off-cut/ });
      expect(canvas.getAttribute('viewBox')).toBe('0 0 2.44 0.61');
      expect(canvas.getAttribute('preserveAspectRatio')).toBe('xMinYMid meet');
      // Fit restores that view after zooming.
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      expect(canvas.getAttribute('viewBox')).not.toBe('0 0 2.44 0.61');
      fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
      expect(canvas.getAttribute('viewBox')).toBe('0 0 2.44 0.61');
    } finally { width.mockRestore(); }
  });

  it('keep an explicit height', () => {
    const events: UiEvent[] = [];
    const view = render(<ExtensionUiView tree={validateUiTree({ ...sheet, height: 436 })} units={DEFAULT_UNITS} onEvent={(e) => events.push(e)} />);
    expect((view.container.querySelector('.pf-xui-vector-frame') as HTMLElement).style.height).toBe('436px');
  });
});
