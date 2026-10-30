// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';

/**
 * Extension UI as a typed component tree. An extension describes a panel, inspector or settings block as a tree of
 * host components and sends the whole tree again, with a higher sequence number, whenever it changes. The host
 * renders it with its own themed, accessible components. There is no markup, style, script or DOM property in the
 * tree: each component has a fixed set of properties, unknown ones are rejected, and the whole tree is bounded in
 * size. User input comes back to the extension as events naming the component, the event and a validated payload.
 */

export const UI_LIMITS = {
  /** Components in one tree, counting every node. */
  nodes: 2000,
  depth: 32,
  /** Characters in any one text value. */
  textChars: 4000,
  /** Rows of one table. The host renders only the rows in view. */
  tableRows: 10_000,
  tableColumns: 50,
  /** Options of one choice field or table column. */
  options: 500,
  tabs: 50,
  /** Items of one tree component, counting every level. */
  treeItems: 5000,
} as const;

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/, 'must be 1-100 letters, digits, or _ . : -');
const text = z.string().max(UI_LIMITS.textChars);
const label = z.string().trim().min(1).max(200);
const tone = z.enum(['default', 'muted', 'info', 'success', 'warning', 'error']);
const option = z.strictObject({ value: z.string().max(200), label });
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * What a number means, so the host can show it in the document's units: `length` values are meters, `area` square
 * meters, `volume` cubic meters, `angle` degrees. `count` and `plain` are shown as they are.
 */
export const UI_QUANTITIES = ['plain', 'count', 'length', 'area', 'volume', 'angle', 'percent'] as const;
export type UiQuantity = (typeof UI_QUANTITIES)[number];
const quantity = z.enum(UI_QUANTITIES);
const finite = z.number().finite();

const children = z.array(z.unknown()).max(UI_LIMITS.nodes);

const component = {
  stack: z.strictObject({ type: z.literal('stack'), id, children,
    direction: z.enum(['vertical', 'horizontal']).optional(), gap: z.enum(['none', 'small', 'medium', 'large']).optional(),
    align: z.enum(['start', 'center', 'end', 'stretch']).optional() }),
  divider: z.strictObject({ type: z.literal('divider'), id }),
  text: z.strictObject({ type: z.literal('text'), id, text, tone: tone.optional(),
    variant: z.enum(['body', 'heading', 'subheading', 'caption', 'code']).optional() }),
  message: z.strictObject({ type: z.literal('message'), id, text, tone: tone.exclude(['default', 'muted']) }),
  progress: z.strictObject({ type: z.literal('progress'), id, label,
    /** 0 to 1, or null while the amount is unknown. */
    value: z.number().min(0).max(1).nullable() }),
  button: z.strictObject({ type: z.literal('button'), id, label, variant: z.enum(['primary', 'secondary', 'danger']).optional(),
    disabled: z.boolean().optional() }),
  textField: z.strictObject({ type: z.literal('textField'), id, label, value: text, placeholder: z.string().max(200).optional(),
    multiline: z.boolean().optional(), maxLength: z.number().int().min(1).max(UI_LIMITS.textChars).optional(), disabled: z.boolean().optional(),
    error: z.string().max(500).optional() }),
  numberField: z.strictObject({ type: z.literal('numberField'), id, label, value: finite.nullable(), quantity: quantity.optional(),
    min: finite.optional(), max: finite.optional(), integer: z.boolean().optional(), disabled: z.boolean().optional(),
    error: z.string().max(500).optional() }),
  checkbox: z.strictObject({ type: z.literal('checkbox'), id, label, checked: z.boolean(), disabled: z.boolean().optional() }),
  choice: z.strictObject({ type: z.literal('choice'), id, label, value: z.string().max(200).nullable(),
    options: z.array(option).min(1).max(UI_LIMITS.options), disabled: z.boolean().optional() }),
  colorField: z.strictObject({ type: z.literal('colorField'), id, label, value: color, disabled: z.boolean().optional() }),
  tabs: z.strictObject({ type: z.literal('tabs'), id, label,
    tabs: z.array(z.strictObject({ id, label })).min(1).max(UI_LIMITS.tabs), selected: id,
    /** One child per tab, in the same order; only the selected tab's child is shown. */
    children }),
  tree: z.strictObject({ type: z.literal('tree'), id, label, items: z.array(z.unknown()),
    expanded: z.array(id).max(UI_LIMITS.treeItems).optional(), selected: id.nullable().optional() }),
  table: z.strictObject({
    type: z.literal('table'), id, label,
    columns: z.array(z.strictObject({
      id, label,
      kind: z.enum(['text', 'number', 'boolean', 'choice']),
      quantity: quantity.optional(),
      options: z.array(option).max(UI_LIMITS.options).optional(),
      editable: z.boolean().optional(),
      sortable: z.boolean().optional(),
      /** Columns the user may hide; hidden ones are listed in `hiddenColumns`. */
      hideable: z.boolean().optional(),
      align: z.enum(['start', 'end']).optional(),
    })).min(1).max(UI_LIMITS.tableColumns),
    rows: z.array(z.strictObject({
      id,
      cells: z.record(z.string(), z.union([z.string().max(UI_LIMITS.textChars), finite, z.boolean(), z.null()])),
      /** Validation messages by column id, shown on the cell. */
      errors: z.record(z.string(), z.string().max(500)).optional(),
      /** A group heading row spanning all columns. */
      heading: z.string().max(500).optional(),
    })),
    sort: z.strictObject({ column: id, direction: z.enum(['ascending', 'descending']) }).nullable().optional(),
    selection: z.enum(['none', 'single', 'multiple']).optional(),
    selected: z.array(id).max(UI_LIMITS.tableRows).optional(),
    hiddenColumns: z.array(id).max(UI_LIMITS.tableColumns).optional(),
  }),
};

export const UI_COMPONENTS = Object.keys(component) as (keyof typeof component)[];
const nodeSchema = z.discriminatedUnion('type', Object.values(component) as unknown as [z.ZodObject, ...z.ZodObject[]]);

type Base<K extends keyof typeof component> = Omit<z.infer<(typeof component)[K]>, 'children' | 'items'>;
export interface UiTreeItem { id: string; label: string; children?: UiTreeItem[] }
export type UiNode =
  | (Base<'stack'> & { children: UiNode[] })
  | Base<'divider'> | Base<'text'> | Base<'message'> | Base<'progress'> | Base<'button'> | Base<'textField'>
  | Base<'numberField'> | Base<'checkbox'> | Base<'choice'> | Base<'colorField'> | Base<'table'>
  | (Base<'tabs'> & { children: UiNode[] })
  | (Base<'tree'> & { items: UiTreeItem[] });
export type UiNodeOf<T extends UiNode['type']> = Extract<UiNode, { type: T }>;
export type UiTable = UiNodeOf<'table'>;

const treeItemSchema = z.strictObject({ id, label, children: z.array(z.unknown()).optional() });

export class UiTreeError extends Error {
  constructor(readonly code: 'validation.failed' | 'limit.exceeded', message: string) {
    super(message);
    this.name = 'UiTreeError';
  }
}

/**
 * Validates a whole tree and returns it typed. Size is checked by a bounded walk before any schema runs, so an
 * oversized tree costs little; then every node is checked against its component, ids are checked to be unique, and
 * table and tree contents against their own bounds. Throws a `UiTreeError` naming the first problem.
 */
export function validateUiTree(input: unknown): UiNode {
  let nodes = 0;
  const count = (value: unknown, depth: number): void => {
    if (depth > UI_LIMITS.depth) throw new UiTreeError('limit.exceeded', `The interface nests deeper than ${UI_LIMITS.depth} levels.`);
    if (++nodes > UI_LIMITS.nodes) throw new UiTreeError('limit.exceeded', `The interface has more than ${UI_LIMITS.nodes} components.`);
    if (typeof value !== 'object' || value === null) return;
    const { children: kids, rows, items } = value as { children?: unknown; rows?: unknown; items?: unknown };
    // Table rows and tree items are bounded here too, so an oversized one is refused before any schema reads it.
    if (Array.isArray(rows) && rows.length > UI_LIMITS.tableRows)
      throw new UiTreeError('limit.exceeded', `A table has more than ${UI_LIMITS.tableRows} rows.`);
    if (Array.isArray(items)) countItems(items, 0);
    if (Array.isArray(kids)) for (const child of kids) count(child, depth + 1);
  };
  let items = 0;
  const countItems = (list: unknown[], depth: number): void => {
    if (depth > UI_LIMITS.depth) throw new UiTreeError('limit.exceeded', `A tree nests deeper than ${UI_LIMITS.depth} levels.`);
    for (const item of list) {
      if (++items > UI_LIMITS.treeItems) throw new UiTreeError('limit.exceeded', `A tree has more than ${UI_LIMITS.treeItems} items.`);
      const sub = typeof item === 'object' && item !== null ? (item as { children?: unknown }).children : undefined;
      if (Array.isArray(sub)) countItems(sub, depth + 1);
    }
  };
  count(input, 0);

  const ids = new Set<string>();
  const check = (value: unknown, path: string): UiNode => {
    const parsed = nodeSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new UiTreeError('validation.failed', `${path}${issue?.path.length ? '.' + issue.path.join('.') : ''}: ${issue?.message ?? 'invalid component'}`);
    }
    const node = parsed.data as Record<string, unknown> & { type: string; id: string };
    if (ids.has(node.id)) throw new UiTreeError('validation.failed', `${path}: the id "${node.id}" is used twice.`);
    ids.add(node.id);
    if (node.type === 'stack' || node.type === 'tabs') {
      const kids = (node.children as unknown[]).map((child, i) => check(child, `${path}.children.${i}`));
      if (node.type === 'tabs') checkTabs(node as unknown as UiNodeOf<'tabs'>, kids, path);
      return { ...node, children: kids } as unknown as UiNode;
    }
    if (node.type === 'tree') return { ...node, items: checkTreeItems(node.items as unknown[], path) } as unknown as UiNode;
    if (node.type === 'table') checkTable(node as unknown as UiTable, path);
    if (node.type === 'choice') {
      const choice = node as unknown as UiNodeOf<'choice'>;
      if (choice.value !== null && !choice.options.some((o) => o.value === choice.value))
        throw new UiTreeError('validation.failed', `${path}: the value is not one of the options.`);
    }
    if (node.type === 'numberField') {
      const field = node as unknown as UiNodeOf<'numberField'>;
      if (field.min !== undefined && field.max !== undefined && field.min > field.max)
        throw new UiTreeError('validation.failed', `${path}: min is greater than max.`);
    }
    return node as unknown as UiNode;
  };
  return check(input, 'root');
}

function checkTabs(node: UiNodeOf<'tabs'>, kids: UiNode[], path: string): void {
  if (kids.length !== node.tabs.length) throw new UiTreeError('validation.failed', `${path}: a tabs component needs one child per tab.`);
  const tabIds = new Set(node.tabs.map((t) => t.id));
  if (tabIds.size !== node.tabs.length) throw new UiTreeError('validation.failed', `${path}: tab ids must be unique.`);
  if (!tabIds.has(node.selected)) throw new UiTreeError('validation.failed', `${path}: the selected tab does not exist.`);
}

function checkTreeItems(items: unknown[], path: string): UiTreeItem[] {
  let total = 0;
  const seen = new Set<string>();
  const walk = (list: unknown[], depth: number): UiTreeItem[] => {
    if (depth > UI_LIMITS.depth) throw new UiTreeError('limit.exceeded', `${path}: the tree nests deeper than ${UI_LIMITS.depth} levels.`);
    return list.map((raw) => {
      if (++total > UI_LIMITS.treeItems) throw new UiTreeError('limit.exceeded', `${path}: the tree has more than ${UI_LIMITS.treeItems} items.`);
      const parsed = treeItemSchema.safeParse(raw);
      if (!parsed.success) throw new UiTreeError('validation.failed', `${path}: invalid tree item (${parsed.error.issues[0]?.message ?? 'unknown'}).`);
      if (seen.has(parsed.data.id)) throw new UiTreeError('validation.failed', `${path}: the tree item id "${parsed.data.id}" is used twice.`);
      seen.add(parsed.data.id);
      const item: UiTreeItem = { id: parsed.data.id, label: parsed.data.label };
      if (parsed.data.children) item.children = walk(parsed.data.children, depth + 1);
      return item;
    });
  };
  return walk(items, 0);
}

function checkTable(table: UiTable, path: string): void {
  const columns = new Map(table.columns.map((c) => [c.id, c] as const));
  if (columns.size !== table.columns.length) throw new UiTreeError('validation.failed', `${path}: column ids must be unique.`);
  const rowIds = new Set<string>();
  for (const [i, row] of table.rows.entries()) {
    if (rowIds.has(row.id)) throw new UiTreeError('validation.failed', `${path}.rows.${i}: the row id "${row.id}" is used twice.`);
    rowIds.add(row.id);
    for (const [key, value] of Object.entries(row.cells)) {
      const column = columns.get(key);
      if (!column) throw new UiTreeError('validation.failed', `${path}.rows.${i}: there is no column "${key}".`);
      const ok = value === null
        || (column.kind === 'number' ? typeof value === 'number'
          : column.kind === 'boolean' ? typeof value === 'boolean'
            : column.kind === 'choice' ? typeof value === 'string' && (column.options ?? []).some((o) => o.value === value)
              : typeof value === 'string');
      if (!ok) throw new UiTreeError('validation.failed', `${path}.rows.${i}: the value in column "${key}" does not fit a ${column.kind} column.`);
    }
  }
  for (const column of table.columns)
    if (column.kind === 'choice' && !column.options?.length) throw new UiTreeError('validation.failed', `${path}: the choice column "${column.id}" has no options.`);
  if (table.sort && !columns.has(table.sort.column)) throw new UiTreeError('validation.failed', `${path}: the sort column does not exist.`);
  for (const hidden of table.hiddenColumns ?? [])
    if (!columns.get(hidden)?.hideable) throw new UiTreeError('validation.failed', `${path}: the column "${hidden}" cannot be hidden.`);
  if (table.selection !== 'multiple' && (table.selected?.length ?? 0) > 1)
    throw new UiTreeError('validation.failed', `${path}: only one row can be selected.`);
}

/** Events the host sends for user input, with their payloads. */
export type UiEvent =
  | { component: string; event: 'press' }
  | { component: string; event: 'change'; value: string | number | boolean | null }
  | { component: string; event: 'select'; value: string | null }
  | { component: string; event: 'toggle'; item: string; expanded: boolean }
  | { component: string; event: 'cellEdit'; row: string; column: string; value: string | number | boolean | null }
  | { component: string; event: 'sort'; column: string; direction: 'ascending' | 'descending' }
  | { component: string; event: 'rowSelect'; rows: string[] }
  | { component: string; event: 'columns'; hidden: string[] };

/** Requests of the `ui` service: mount or replace the tree of a target, or remove it. */
export const uiMountSchema = z.strictObject({ target: z.string().min(1).max(200), seq: z.number().int().nonnegative(), tree: z.unknown() });
export const uiUnmountSchema = z.strictObject({ target: z.string().min(1).max(200) });
