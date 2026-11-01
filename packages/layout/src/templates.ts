// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { allocId } from '@pushform/model';
import { createLayoutDocumentState, type LayoutDocumentState, type LayoutEntity } from './LayoutDocument';

export type LayoutTemplateCategory = 'Paper' | 'Storyboard' | 'Titleblock';
export interface LayoutTemplate {
  id: string;
  name: string;
  category: LayoutTemplateCategory;
  section: string;
  size: readonly [number, number];
  units: 'mm' | 'inch';
  gridMm: number | null;
  frames?: readonly [number, number];
}
const sizes = [
  { id: 'a3', name: 'A3', landscape: [420, 297], units: 'mm' },
  { id: 'a4', name: 'A4', landscape: [297, 210], units: 'mm' },
  { id: 'letter', name: 'Letter', landscape: [279.4, 215.9], units: 'inch' },
  { id: 'tabloid', name: 'Tabloid', landscape: [431.8, 279.4], units: 'inch' },
] as const;
const paper: LayoutTemplate[] = [];
for (const size of sizes) {
  for (const orientation of ['Landscape', 'Portrait'] as const) {
    const dimensions = orientation === 'Landscape' ? size.landscape : [size.landscape[1], size.landscape[0]] as const;
    const base = `${size.id}-${orientation.toLowerCase()}`;
    paper.push({ id: `plain-${base}`, name: `${size.name} ${orientation}`, category: 'Paper', section: 'Plain Paper', size: dimensions, units: size.units, gridMm: null });
    if (size.units === 'mm') {
      if (size.id === 'a3' && orientation === 'Portrait') continue;
      paper.push({ id: `graph-${base}`, name: `${size.name} ${orientation}`, category: 'Paper', section: 'Graph Paper', size: dimensions, units: size.units, gridMm: 5 });
    } else {
      if (size.id === 'tabloid' && orientation === 'Portrait') continue;
      for (const division of [4, 8, 10]) paper.push({ id: `graph-${base}-div${division}`,
        name: `${size.name}${size.id === 'tabloid' ? '' : ` ${orientation}`} div${division}`,
        category: 'Paper', section: 'Graph Paper', size: dimensions, units: size.units, gridMm: 25.4 / division });
    }
  }
}
export const DEFAULT_LAYOUT_TEMPLATE_ID = 'graph-a4-landscape';
export const LAYOUT_TEMPLATES: readonly LayoutTemplate[] = [
  ...paper.filter(t => t.section === 'Graph Paper'), ...paper.filter(t => t.section === 'Plain Paper'),
  ...([[2, 2], [3, 2], [2, 3], [3, 3]] as const).map(([columns, rows]): LayoutTemplate => ({
    id: `storyboard-${columns}x${rows}`, name: `${columns * rows} Frames${columns * rows === 6 ? ` (${columns} × ${rows})` : ''}`, category: 'Storyboard', section: 'Storyboard',
    size: [297, 210], units: 'mm', gridMm: null, frames: [columns, rows],
  })),
  ...sizes.map(size => ({ id: `titleblock-${size.id}`, name: `${size.name} Landscape`, category: 'Titleblock' as const,
    section: 'Titleblock', size: size.landscape, units: size.units, gridMm: null })),
];

/** Instantiate template contents before creating the document, so they are its clean initial state. */
export function createLayoutTemplateState(templateId: string): LayoutDocumentState {
  const template = LAYOUT_TEMPLATES.find(t => t.id === templateId);
  if (!template) throw new Error(`Unknown Layout template: ${templateId}`);
  const state = createLayoutDocumentState(), page = state.pages.get(state.pageOrder[0]!)!;
  page.size = [...template.size]; state.settings.units = template.units;
  // Paper, grid and drawing values all use the template's units: inches for US paper, millimeters otherwise.
  const unit = template.units === 'mm' ? 'mm' : 'in';
  state.settings.paperUnits = unit; state.settings.grid.units = unit;
  state.settings.grid.show = template.gridMm !== null;
  state.settings.grid.spacingMm = template.gridMm ?? (unit === 'in' ? 6.35 : 10);
  if (template.category === 'Paper') return state;
  const layerId = allocId(state);
  state.layers.set(layerId, { id: layerId, name: 'Frame', visible: true, locked: false, shared: true });
  state.layerOrder.unshift(layerId);
  const add = (entity: Omit<LayoutEntity, 'id' | 'layerId'>) => {
    const id = allocId(state); state.sharedEntities.set(id, { ...entity, id, layerId }); state.sharedEntityOrder.push(id);
  };
  const line = (points: [number, number][], closed = false) => add({ kind: 'path', points, closed,
    style: { strokeColor: '#334155', strokeWeightPt: 0.5, fillColor: null } });
  const rectangle = (x: number, y: number, width: number, height: number) => line([[x, y], [x + width, y], [x + width, y + height], [x, y + height]], true);
  const text = (content: string, x: number, y: number, width: number, height: number, fontSizePt = 10, bold = false) => add({
    kind: 'text', points: [[x, y], [x + width, y + height]], closed: false,
    text: { content, fontFamily: 'Arial', fontSizePt, color: '#334155', bold, italic: false, underline: false,
      align: 'left', vertical: 'middle', bounded: true, leader: 'none', endpoint: 'none' },
  });
  const [width, height] = page.size;
  if (template.frames) {
    text('STORYBOARD', 12, 10, width - 24, 12, 16, true);
    const [columns, rows] = template.frames, gap = 8;
    const cellWidth = (width - 24 - gap * (columns - 1)) / columns;
    const cellHeight = (height - 42 - gap * (rows - 1)) / rows;
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const x = 12 + column * (cellWidth + gap), y = 28 + row * (cellHeight + gap);
      const frameHeight = Math.min(cellHeight - 8, cellWidth * 9 / 16);
      rectangle(x, y, cellWidth, frameHeight);
      text(`Frame ${row * columns + column + 1}`, x, y + frameHeight + 1, cellWidth, 7, 8);
    }
  } else {
    rectangle(10, 10, width - 20, height - 20);
    const top = height - 42, split = width * 0.65;
    line([[10, top], [width - 10, top]]); line([[split, top], [split, height - 10]]);
    line([[split, height - 25], [width - 10, height - 25]]);
    state.customFields.set('ProjectName', 'Project name');
    text('<ProjectName>', 14, top + 2, split - 20, 12, 14, true);
    text('<PageName>', 14, top + 16, split - 20, 10, 10);
    text('DRAWING', split + 4, top + 1, width - split - 18, 5, 7, true);
    text('<FileName>', split + 4, top + 6, width - split - 18, 10, 9);
    text('SHEET <PageNumber> / <PageCount>', split + 4, height - 23, width - split - 18, 10, 10, true);
  }
  return state;
}
