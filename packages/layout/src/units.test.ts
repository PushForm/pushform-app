// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocumentState, layoutDimensionUnits, layoutDrawingUnits, layoutGridUnits, layoutPaperUnits, setLayoutGridUnits } from './LayoutDocument';
import { createLayoutTemplateState } from './templates';

it('falls back to the drawing units for paper and grid units the document does not set', () => {
  const state = createLayoutDocumentState();
  expect([layoutPaperUnits(state), layoutGridUnits(state), layoutDrawingUnits(state)]).toEqual(['mm', 'mm', 'mm']);
  state.settings.units = 'architectural';
  expect([layoutPaperUnits(state), layoutGridUnits(state), layoutDrawingUnits(state)]).toEqual(['in', 'in', 'architectural']);
  // The grid units decide drawing values.
  state.settings.grid.units = 'mm';
  expect(layoutDrawingUnits(state)).toBe('mm');
});

it('sets drawing values to the grid units and rounds the grid size to a usual size in them', () => {
  const state = createLayoutDocumentState();
  setLayoutGridUnits(state.settings, 'in');
  expect(state.settings).toMatchObject({ units: 'inch', grid: { units: 'in', spacingMm: 12.7 } });
  state.settings.grid.spacingMm = 6.35;
  setLayoutGridUnits(state.settings, 'mm');
  expect(state.settings).toMatchObject({ units: 'mm', grid: { units: 'mm', spacingMm: 5 } });
  // The same units keep the size; architectural inches stay architectural.
  state.settings.grid.spacingMm = 7;
  setLayoutGridUnits(state.settings, 'mm');
  expect(state.settings.grid.spacingMm).toBe(7);
  state.settings.units = 'architectural'; state.settings.grid.units = 'in';
  setLayoutGridUnits(state.settings, 'in');
  expect(state.settings.units).toBe('architectural');
});

it('starts US templates in inches and international ones in millimeters, for paper, grid and drawing', () => {
  const letter = createLayoutTemplateState('plain-letter-landscape');
  expect(letter.settings).toMatchObject({ units: 'inch', paperUnits: 'in', grid: { units: 'in', spacingMm: 6.35 } });
  const a4 = createLayoutTemplateState('plain-a4-landscape');
  expect(a4.settings).toMatchObject({ units: 'mm', paperUnits: 'mm', grid: { units: 'mm', spacingMm: 10 } });
});

it('gives new dimensions the drawing units', () => {
  const state = createLayoutDocumentState();
  expect(layoutDimensionUnits(state)).toEqual({ units: 'mm', precision: 1, format: 'decimal' });
  state.settings.grid.units = 'in';
  expect(layoutDimensionUnits(state)).toEqual({ units: 'inch', precision: 2, format: 'decimal' });
  state.settings.units = 'architectural';
  expect(layoutDimensionUnits(state)).toEqual({ units: 'inch', precision: 4, format: 'architectural' });
});
