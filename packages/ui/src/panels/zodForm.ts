// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { z } from 'zod';

/**
 * Minimal zod v4 introspection for the Last Operation panel: a `z.object` shape becomes a list
 * of editable fields. Numbers, strings, booleans, enums/literals and 3-number tuples get
 * dedicated inputs; everything else (nested objects, arrays, unions) is edited as JSON.
 */
export type FieldSpec =
  | { readonly key: string; readonly kind: 'number'; readonly optional: boolean; readonly int: boolean }
  | { readonly key: string; readonly kind: 'string'; readonly optional: boolean }
  | { readonly key: string; readonly kind: 'boolean'; readonly optional: boolean }
  | { readonly key: string; readonly kind: 'enum'; readonly optional: boolean; readonly options: readonly string[] }
  | { readonly key: string; readonly kind: 'vec3'; readonly optional: boolean }
  | { readonly key: string; readonly kind: 'json'; readonly optional: boolean };

/** The parts of zod's internal `def` this module reads. */
interface ZodDef {
  readonly type?: string;
  readonly innerType?: ZodLike;
  readonly shape?: Record<string, ZodLike>;
  readonly entries?: Record<string, string | number>;
  readonly values?: readonly unknown[];
  readonly items?: readonly ZodLike[];
  readonly checks?: readonly { readonly _zod?: { readonly def?: { readonly check?: string } } }[];
}
interface ZodLike {
  readonly def?: ZodDef;
  readonly _zod?: { readonly def?: ZodDef };
}

function defOf(s: unknown): ZodDef | null {
  const z = s as ZodLike | null | undefined;
  return z?.def ?? z?._zod?.def ?? null;
}

const WRAPPERS = new Set(['optional', 'default', 'nullable', 'nonoptional', 'readonly', 'catch', 'prefault']);

/** Strip optional/default/nullable wrappers; reports whether the field may be omitted. */
function unwrap(s: ZodLike): { def: ZodDef | null; optional: boolean } {
  let def = defOf(s);
  let optional = false;
  for (let i = 0; def && def.type && WRAPPERS.has(def.type) && i < 8; i++) {
    if (def.type === 'optional' || def.type === 'default' || def.type === 'nullable') optional = true;
    def = def.innerType ? defOf(def.innerType) : null;
  }
  return { def, optional };
}

function fieldOf(key: string, s: ZodLike): FieldSpec {
  const { def, optional } = unwrap(s);
  switch (def?.type) {
    case 'number': {
      const int = (def.checks ?? []).some((c) => c._zod?.def?.check === 'number_format');
      return { key, kind: 'number', optional, int };
    }
    case 'string':
      return { key, kind: 'string', optional };
    case 'boolean':
      return { key, kind: 'boolean', optional };
    case 'enum':
      return { key, kind: 'enum', optional, options: Object.values(def.entries ?? {}).map(String) };
    case 'literal':
      return { key, kind: 'enum', optional, options: (def.values ?? []).map(String) };
    case 'tuple': {
      const items = def.items ?? [];
      if (items.length === 3 && items.every((it) => unwrap(it).def?.type === 'number')) return { key, kind: 'vec3', optional };
      return { key, kind: 'json', optional };
    }
    default:
      return { key, kind: 'json', optional };
  }
}

/** Fields of a `z.object` schema (refinements keep the shape); null for non-object schemas. */
export function describeSchema(schema: z.ZodType | undefined): FieldSpec[] | null {
  if (!schema) return null;
  const { def } = unwrap(schema as unknown as ZodLike);
  const shape = def?.type === 'object' ? def.shape : undefined;
  if (!shape) return null;
  return Object.entries(shape).map(([key, s]) => fieldOf(key, s));
}

/** Parse the text of a number input; null when empty or not a number. */
export function parseNumberInput(text: string, int: boolean): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return int ? Math.round(n) : n;
}
