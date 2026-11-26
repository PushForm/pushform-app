// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
import type { InspectorCapture } from './inspector.ts';

/**
 * Interface trees. A sidebar, panel, inspector or settings block is a tree of these components, sent whole with
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

/**
 * Icons a button, menu or section action may show, drawn by PushForm from its own icon set. The names say what the
 * control does rather than what the glyph looks like.
 */
export type UiIcon = 'add' | 'remove' | 'delete' | 'edit' | 'copy' | 'save' | 'print' | 'download' | 'upload' | 'search' | 'filter' | 'refresh'
  | 'settings' | 'help' | 'info' | 'warning' | 'check' | 'close' | 'more' | 'menu' | 'expand' | 'collapse' | 'up' | 'down' | 'show' | 'hide'
  | 'lock' | 'unlock' | 'undo' | 'redo' | 'folder' | 'document' | 'tag' | 'tags' | 'palette' | 'box' | 'component' | 'table' | 'ruler'
  | 'saw-blade';

export interface UiStack {
  /** Display units inherited by this subtree; all quantities in events and stored values remain canonical. */
  displayUnits?: { lengthUnit: 'mm' | 'cm' | 'm' | 'in' | 'ft'; format: 'decimal' | 'architectural' | 'fractional' | 'engineering'; lengthPrecision: number } | undefined;
  type: 'stack'; id: string; children: UiNode[]; direction?: 'vertical' | 'horizontal' | undefined;
  gap?: 'none' | 'small' | 'medium' | 'large' | undefined; align?: 'start' | 'center' | 'end' | 'stretch' | undefined }
export interface UiDivider { type: 'divider'; id: string }
export interface UiText { type: 'text'; id: string; text: string; tone?: UiTone | undefined;
  variant?: 'body' | 'heading' | 'subheading' | 'caption' | 'code' | undefined }
export interface UiMessage { type: 'message'; id: string; text: string; tone: 'info' | 'success' | 'warning' | 'error' }
/** `value` from 0 to 1, or null while the amount is unknown. */
export interface UiProgress { type: 'progress'; id: string; label: string; value: number | null }
/** `variant: 'icon'` shows only the icon, with the label as the accessible name and tooltip, for compact toolbars; it needs an `icon`. */
export interface UiButton { type: 'button'; id: string; label: string; variant?: 'primary' | 'secondary' | 'danger' | 'icon' | undefined;
  icon?: UiIcon | undefined; disabled?: boolean | undefined; tool?: string | undefined }
/**
 * A disclosure: a header with a title, an optional subtitle and badge, and up to 8 header action buttons, over
 * children shown unless `collapsed`. The header reports `collapse` with the state the user asked for; an action
 * reports `press` with its id in `action`. Send the updated tree in reply.
 */
export interface UiSection { type: 'section'; id: string; title: string; subtitle?: string | undefined; badge?: string | undefined;
  collapsed?: boolean | undefined; actions?: UiSectionAction[] | undefined; children: UiNode[] }
export interface UiSectionAction { id: string; label: string; icon?: UiIcon | undefined; disabled?: boolean | undefined }
/**
 * A button that opens a dropdown of up to 50 items; choosing one reports `select` with its id. A `separator` item is
 * drawn with a line above it. `variant: 'icon'` shows only the icon, with the label as the accessible name.
 */
export interface UiMenu { type: 'menu'; id: string; label: string; icon?: UiIcon | undefined; variant?: 'secondary' | 'icon' | undefined;
  disabled?: boolean | undefined; items: UiMenuItem[] }
export interface UiMenuItem { id: string; label: string; disabled?: boolean | undefined; separator?: boolean | undefined; tool?: string | undefined }
export interface UiTextField { mixed?: boolean | undefined; source?: string | undefined; type: 'textField'; id: string; label: string; value: string; placeholder?: string | undefined;
  multiline?: boolean | undefined; maxLength?: number | undefined; disabled?: boolean | undefined; error?: string | undefined }
export interface UiNumberField { mixed?: boolean | undefined; source?: string | undefined; type: 'numberField'; id: string; label: string; value: number | null; quantity?: UiQuantity | undefined;
  min?: number | undefined; max?: number | undefined; integer?: boolean | undefined; disabled?: boolean | undefined; error?: string | undefined }
export interface UiCheckbox { mixed?: boolean | undefined; source?: string | undefined; type: 'checkbox'; id: string; label: string; checked: boolean; disabled?: boolean | undefined }
export interface UiChoice { mixed?: boolean | undefined; source?: string | undefined; type: 'choice'; id: string; label: string; value: string | null; options: UiOption[]; disabled?: boolean | undefined }
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

/**
 * A paint style of a vector view, referred to by its index in `styles`. Colors are `#rrggbb`; stroke widths are screen
 * pixels. A shape with neither fill nor stroke is drawn with a thin line in the text color.
 */
export interface UiVectorStyle {
  fill?: string | undefined; stroke?: string | undefined; strokeWidth?: number | undefined;
  dash?: 'solid' | 'dashed' | 'dotted' | undefined; hatch?: boolean | undefined; opacity?: number | undefined;
  fontWeight?: 'normal' | 'bold' | undefined;
}
/**
 * A shape of a vector view. `item` makes it hoverable and clickable and names it in `hover` and `select` events
 * (several shapes may share one); `tip` is shown on hover. Text `size` is in drawing units; `angle` is in degrees,
 * counterclockwise. Polyline `points` are x, y pairs.
 */
export type UiVectorShape =
  | { kind: 'rect'; x: number; y: number; width: number; height: number; style: number; item?: string | undefined; tip?: string | undefined }
  | { kind: 'polyline'; points: number[]; closed?: boolean | undefined; style: number; item?: string | undefined; tip?: string | undefined }
  | { kind: 'text'; x: number; y: number; text: string; size: number; anchor?: 'start' | 'middle' | 'end' | undefined; angle?: number | undefined;
    style: number; item?: string | undefined; tip?: string | undefined };
/**
 * A read-only drawing, such as a cutting diagram, that the user can zoom, pan, hover and click. x grows rightwards
 * and y downwards. With `units: 'length'` coordinates are meters, which sets the scale of `ui.export`. Up to 20,000
 * shapes, 400,000 polyline coordinates and 64 styles.
 */
export interface UiVector {
  type: 'vector'; id: string; label: string;
  bounds: { x: number; y: number; width: number; height: number };
  units: 'length' | 'plain';
  /**
   * On-screen height in pixels, 80 to 2000. When absent, the frame follows the drawing's proportions at the width
   * available, from 120 to 800 pixels, so the whole drawing shows without empty space above and below it.
   */
  height?: number | undefined;
  /**
   * Sizes the drawing as if it were this wide, in drawing units, so that several drawings share one scale: an
   * off-cut given a full sheet's `fitWidth` draws smaller than the sheet. A value under the drawing's width is taken
   * as the drawing's width.
   */
  fitWidth?: number | undefined;
  styles: UiVectorStyle[];
  shapes: UiVectorShape[];
  /** Items shown highlighted. */
  selected?: string[] | undefined;
}

export type UiNode = UiStack | UiDivider | UiText | UiMessage | UiProgress | UiButton | UiTextField | UiNumberField | UiCheckbox | UiChoice
  | UiColorField | UiTabs | UiTree | UiTable | UiVector | UiSection | UiMenu;

/** User input on a mounted interface or its dialog. Sorting and selection are reported; send the updated tree in reply. */
export type UiEvent =
  /** A button was pressed; or, with `action`, a section's header action. */
  | { component: string; event: 'press'; action?: string }
  | { component: string; event: 'change'; value: string | number | boolean | null }
  /** A tab, a tree item, a vector item, or a menu item was chosen. */
  | { component: string; event: 'select'; value: string | null }
  | { component: string; event: 'toggle'; item: string; expanded: boolean }
  /** The user asked to collapse or expand a section. */
  | { component: string; event: 'collapse'; collapsed: boolean }
  /** The user closed a dialog with Escape or its Close button; `component` is the dialog tree's root. The dialog is gone already. */
  | { component: string; event: 'dialogClose' }
  | { component: string; event: 'cellEdit'; row: string; column: string; value: string | number | boolean | null }
  | { component: string; event: 'sort'; column: string; direction: 'ascending' | 'descending' }
  | { component: string; event: 'rowSelect'; rows: string[] }
  | { component: string; event: 'columns'; hidden: string[] }
  /** The pointer moved onto a vector view item, or off every item. Clicking one sends `select`. */
  | { component: string; event: 'hover'; item: string | null };

/** An event with the target (sidebar, panel, inspector or settings contribution id) it happened on. */
export type UiEventOnTarget = { target: string; inspector?: InspectorCapture } & UiEvent;

/**
 * What `ui.print` prints: components of `target` on screen, in order, at `page` size in meters (0.02 to 2 a side;
 * landscape when wider than tall). A `vector` view is one page, at its real size when it fits. Tables, text and
 * dividers, and stacks holding only printable components, flow over as many pages as they need, under `title` (the
 * first component's label when absent) and with page numbers; any other component is refused. Tables print without
 * their hidden columns, with the header row on every page and numbers in the document's units, as the panel shows
 * them. At most 200 components and 500 pages.
 */
export interface UiPrintRequest {
  target: string;
  components: string[];
  page: { width: number; height: number };
  purpose: string;
  title?: string | undefined;
}
