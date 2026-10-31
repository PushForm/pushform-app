// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors

/**
 * Interface trees. A panel, inspector or settings block is a tree of these components, sent whole with
 * `context.ui.mount` and again, with a higher sequence number, with `context.ui.update`. PushForm draws them with its
 * own components; extensions never supply markup or styles. Every node needs an `id` unique in its tree.
 */

export type UiTone = 'default' | 'muted' | 'info' | 'success' | 'warning' | 'error';

/**
 * What a number means, so PushForm can show it in the document's units: `length` in meters, `area` in square meters,
 * `volume` in cubic meters, `angle` in degrees; `percent` is a fraction from 0 to 1.
 */
export type UiQuantity = 'plain' | 'count' | 'length' | 'area' | 'volume' | 'angle' | 'percent';

export interface UiOption {
  value: string;
  label: string;
}

export interface UiStack { type: 'stack'; id: string; children: UiNode[]; direction?: 'vertical' | 'horizontal' | undefined;
  gap?: 'none' | 'small' | 'medium' | 'large' | undefined; align?: 'start' | 'center' | 'end' | 'stretch' | undefined }
export interface UiDivider { type: 'divider'; id: string }
export interface UiText { type: 'text'; id: string; text: string; tone?: UiTone | undefined;
  variant?: 'body' | 'heading' | 'subheading' | 'caption' | 'code' | undefined }
export interface UiMessage { type: 'message'; id: string; text: string; tone: 'info' | 'success' | 'warning' | 'error' }
/** `value` from 0 to 1, or null while the amount is unknown. */
export interface UiProgress { type: 'progress'; id: string; label: string; value: number | null }
export interface UiButton { type: 'button'; id: string; label: string; variant?: 'primary' | 'secondary' | 'danger' | undefined; disabled?: boolean | undefined }
export interface UiTextField { type: 'textField'; id: string; label: string; value: string; placeholder?: string | undefined;
  multiline?: boolean | undefined; maxLength?: number | undefined; disabled?: boolean | undefined; error?: string | undefined }
export interface UiNumberField { type: 'numberField'; id: string; label: string; value: number | null; quantity?: UiQuantity | undefined;
  min?: number | undefined; max?: number | undefined; integer?: boolean | undefined; disabled?: boolean | undefined; error?: string | undefined }
export interface UiCheckbox { type: 'checkbox'; id: string; label: string; checked: boolean; disabled?: boolean | undefined }
export interface UiChoice { type: 'choice'; id: string; label: string; value: string | null; options: UiOption[]; disabled?: boolean | undefined }
export interface UiColorField { type: 'colorField'; id: string; label: string; value: string; disabled?: boolean | undefined }
/** One child per tab, in the same order; only the selected tab's child is shown. */
export interface UiTabs { type: 'tabs'; id: string; label: string; tabs: { id: string; label: string }[]; selected: string; children: UiNode[] }
export interface UiTreeItem { id: string; label: string; children?: UiTreeItem[] }
export interface UiTree { type: 'tree'; id: string; label: string; items: UiTreeItem[]; expanded?: string[] | undefined; selected?: string | null | undefined }

export interface UiTableColumn {
  id: string;
  label: string;
  kind: 'text' | 'number' | 'boolean' | 'choice';
  quantity?: UiQuantity | undefined;
  options?: UiOption[] | undefined;
  editable?: boolean | undefined;
  sortable?: boolean | undefined;
  /** Columns the user may hide from the Columns menu; hidden ones are listed in the table's `hiddenColumns`. */
  hideable?: boolean | undefined;
  align?: 'start' | 'end' | undefined;
}
export interface UiTableRow {
  id: string;
  cells: Record<string, string | number | boolean | null>;
  /** Validation messages by column id, marked on the cell. */
  errors?: Record<string, string> | undefined;
  /** A group heading spanning all columns instead of cells. */
  heading?: string | undefined;
}
export interface UiTable {
  type: 'table'; id: string; label: string; columns: UiTableColumn[]; rows: UiTableRow[];
  sort?: { column: string; direction: 'ascending' | 'descending' } | null | undefined;
  selection?: 'none' | 'single' | 'multiple' | undefined;
  selected?: string[] | undefined;
  hiddenColumns?: string[] | undefined;
}

export type UiNode = UiStack | UiDivider | UiText | UiMessage | UiProgress | UiButton | UiTextField | UiNumberField | UiCheckbox | UiChoice
  | UiColorField | UiTabs | UiTree | UiTable;

/** User input on a mounted interface. Sorting and selection are reported; send the updated tree in reply. */
export type UiEvent =
  | { component: string; event: 'press' }
  | { component: string; event: 'change'; value: string | number | boolean | null }
  | { component: string; event: 'select'; value: string | null }
  | { component: string; event: 'toggle'; item: string; expanded: boolean }
  | { component: string; event: 'cellEdit'; row: string; column: string; value: string | number | boolean | null }
  | { component: string; event: 'sort'; column: string; direction: 'ascending' | 'descending' }
  | { component: string; event: 'rowSelect'; rows: string[] }
  | { component: string; event: 'columns'; hidden: string[] };

/** An event with the target (panel, inspector or settings contribution id) it happened on. */
export type UiEventOnTarget = { target: string } & UiEvent;
